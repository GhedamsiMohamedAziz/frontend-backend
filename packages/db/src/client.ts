import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema/index';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Who the request is acting as. Both values scope every query it makes. */
export interface OrgContext {
  organizationId: string;
  userId?: string | null;
}

export interface DbOptions extends Omit<PoolConfig, 'connectionString'> {
  url: string;
}

/**
 * The tenant-scoped database handle.
 *
 * There is deliberately no exported `db` object you can query directly. Every
 * read and write goes through `withOrg`, which opens a transaction and sets the
 * session variables the RLS policies read (ADR-002). Making that the only door
 * is the whole point: a query that forgets its `WHERE organization_id = ...`
 * then returns zero rows instead of another tenant's data.
 */
export class TenantDb {
  private readonly pool: Pool;
  private readonly db: Database;

  constructor(options: DbOptions) {
    const { url, ...rest } = options;
    this.pool = new Pool({ connectionString: url, ...rest });
    this.db = drizzle(this.pool, { schema, casing: 'snake_case' });
  }

  /**
   * Run `fn` inside a transaction scoped to one organization.
   *
   * `set_config(..., true)` is the parameterized form of `SET LOCAL`: it is
   * bound as a value rather than interpolated, and it reverts when the
   * transaction ends, so a pooled connection can never leak one tenant's
   * context into the next request that borrows it.
   */
  async withOrg<T>(ctx: OrgContext, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.current_org_id', ${ctx.organizationId}, true),
                   set_config('app.current_user_id', ${ctx.userId ?? ''}, true)`,
      );
      return fn(tx);
    });
  }

  /**
   * Run `fn` with a user context but no organization.
   *
   * Used only by the parts of the identity flow that legitimately span
   * organizations — "which orgs do I belong to?" — where scoping to one tenant
   * would be the wrong question. Tenant tables still return nothing here,
   * because `app.current_org_id` is unset and the policies compare against NULL.
   */
  async withUser<T>(userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.current_org_id', '', true),
                   set_config('app.current_user_id', ${userId}, true)`,
      );
      return fn(tx);
    });
  }

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * An unscoped handle that bypasses RLS, for the two jobs that cannot be
 * tenant-scoped: migrations, and the identity bootstrap at login (finding or
 * creating a user before any organization context exists).
 *
 * Kept as a separate class with a separate connection URL so that "who can
 * bypass isolation" is a question with a short, greppable answer.
 */
export class SystemDb {
  private readonly pool: Pool;
  readonly db: Database;

  constructor(options: DbOptions) {
    const { url, ...rest } = options;
    this.pool = new Pool({ connectionString: url, ...rest });
    this.db = drizzle(this.pool, { schema, casing: 'snake_case' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
