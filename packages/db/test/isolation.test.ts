import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { TenantDb } from '../src/client';
import * as schema from '../src/schema/index';
import { appUrl, loadEnv, migrationUrl } from '../scripts/env';

loadEnv();

/**
 * Tenant isolation (ADR-002).
 *
 * This is the test M0 exists to make possible. Multi-tenant SaaS turns a single
 * forgotten `WHERE organization_id = ...` into a cross-tenant data leak, so the
 * claim under test is not "our queries are careful" — it is "the database
 * refuses, even when the query is wrong".
 *
 * Everything here connects as `eyesonbug_app`, the role the API and worker use:
 * not the table owner, and NOBYPASSRLS.
 */
describe('row-level security', () => {
  let tenant: TenantDb;
  let owner: Pool;
  let acmeId: string;
  let northwindId: string;
  let acmeUserId: string;

  beforeAll(async () => {
    tenant = new TenantDb({ url: appUrl(), max: 4 });
    owner = new Pool({ connectionString: migrationUrl(), max: 2 });

    const orgs = await owner.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM organization WHERE slug IN ('acme-retail','northwind')`,
    );
    acmeId = orgs.rows.find((r) => r.slug === 'acme-retail')!.id;
    northwindId = orgs.rows.find((r) => r.slug === 'northwind')!.id;

    const user = await owner.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = 'demo@eyesonbug.dev'`,
    );
    acmeUserId = user.rows[0]!.id;
  });

  afterAll(async () => {
    await tenant.close();
    await owner.end();
  });

  it('runs the application as a role that cannot bypass RLS', async () => {
    const { rows } = await owner.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'eyesonbug_app'`,
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });

  it('covers every table that carries an organization_id — no table can be forgotten', async () => {
    const { rows } = await owner.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
        AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r','p')
        AND (
          c.relrowsecurity = false
          OR NOT EXISTS (SELECT 1 FROM pg_policies p
                         WHERE p.schemaname = 'public' AND p.tablename = c.relname)
        )
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('shows a tenant only its own rows, even when the query has no org predicate', async () => {
    // Deliberately no `where organization_id = ...`: that is the whole point.
    const acmeProjects = await tenant.withOrg({ organizationId: acmeId }, (tx) =>
      tx.select({ slug: schema.projects.slug }).from(schema.projects),
    );
    const northwindProjects = await tenant.withOrg({ organizationId: northwindId }, (tx) =>
      tx.select({ slug: schema.projects.slug }).from(schema.projects),
    );

    expect(acmeProjects.map((p) => p.slug).sort()).toEqual([
      'checkout-api',
      'mobile-web',
      'storefront',
    ]);
    expect(northwindProjects.map((p) => p.slug)).toEqual(['northwind-shop']);
  });

  it('isolates the partitioned fact table too, through the parent', async () => {
    const countFor = async (organizationId: string): Promise<number> => {
      const rows = await tenant.withOrg({ organizationId }, (tx) =>
        tx.execute<{ count: string }>(sql`select count(*)::text as count from test_result`),
      );
      return Number(rows.rows[0]!.count);
    };

    const acmeCount = await countFor(acmeId);
    const northwindCount = await countFor(northwindId);
    const total = await owner.query<{ count: string }>('SELECT count(*)::text FROM test_result');

    expect(acmeCount).toBeGreaterThan(0);
    expect(northwindCount).toBeGreaterThan(0);
    // The two tenants partition the table exactly: neither sees a row of the
    // other's, and between them they account for everything.
    expect(acmeCount + northwindCount).toBe(Number(total.rows[0]!.count));
  });

  it('sees nothing at all when no organization context is set', async () => {
    const rows = await tenant.withUser(acmeUserId, (tx) =>
      tx.select({ slug: schema.projects.slug }).from(schema.projects),
    );
    expect(rows).toEqual([]);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await expect(
      tenant.withOrg({ organizationId: acmeId }, (tx) =>
        tx.insert(schema.projects).values({
          organizationId: northwindId, // the attack
          slug: 'smuggled',
          name: 'Smuggled',
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to move an existing row into another tenant', async () => {
    await expect(
      tenant.withOrg({ organizationId: acmeId }, (tx) =>
        tx
          .update(schema.projects)
          .set({ organizationId: northwindId })
          .where(sql`${schema.projects.slug} = 'storefront'`),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot read another tenant row by guessing its primary key', async () => {
    const northwindProject = await owner.query<{ id: string }>(
      `SELECT id FROM project WHERE slug = 'northwind-shop'`,
    );
    const target = northwindProject.rows[0]!.id;

    const rows = await tenant.withOrg({ organizationId: acmeId }, (tx) =>
      tx.execute<{ id: string }>(sql`select id from project where id = ${target}`),
    );
    expect(rows.rows).toEqual([]);
  });

  it('does not let one tenant enumerate another tenant users', async () => {
    const visible = await tenant.withOrg({ organizationId: acmeId, userId: acmeUserId }, (tx) =>
      tx.execute<{ email: string }>(sql`select email from "user"`),
    );
    const emails = visible.rows.map((r) => r.email);

    expect(emails).toContain('demo@eyesonbug.dev');
    expect(emails).not.toContain('outsider@northwind.dev');
  });

  it('lets an actor list their own memberships before choosing an organization', async () => {
    const rows = await tenant.withUser(acmeUserId, (tx) =>
      tx.execute<{ organization_id: string }>(
        sql`select organization_id from org_membership where user_id = ${acmeUserId}`,
      ),
    );
    expect(rows.rows.map((r) => r.organization_id)).toEqual([acmeId]);
  });

  it('does not leak context between pooled connections', async () => {
    // Interleave two tenants across many round trips. If `SET LOCAL` ever
    // escaped its transaction, a borrowed connection would answer with the
    // previous tenant's context.
    const work = Array.from({ length: 24 }, (_, i) => {
      const organizationId = i % 2 === 0 ? acmeId : northwindId;
      const expected = i % 2 === 0 ? 3 : 1;
      return tenant
        .withOrg({ organizationId }, (tx) => tx.select().from(schema.projects))
        .then((rows) => expect(rows).toHaveLength(expected));
    });
    await Promise.all(work);
  });
});
