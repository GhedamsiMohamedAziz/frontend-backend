import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { SystemDb } from '@eyesonbug/db';
import { schema } from '@eyesonbug/db';
import { capabilitiesFor, type OrgRole, type ProjectRole } from '@eyesonbug/shared';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { SYSTEM_DB } from '../database/database.module';

/**
 * Resolves "who is this, in this organization, on this project" from the slugs
 * in the URL.
 *
 * Runs on the system handle because it is the step that *establishes* tenant
 * context — it cannot itself be scoped by the context it is producing. It reads
 * only membership rows, and every failure to find one is reported as 404
 * rather than 403: confirming that `/o/acme/p/secret-project` exists is a
 * disclosure in its own right.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(SYSTEM_DB) private readonly system: SystemDb) {}

  async forOrganization(userId: string, orgSlug: string): Promise<AccessContext> {
    const rows = await this.system.db
      .select({
        organizationId: schema.organizations.id,
        organizationSlug: schema.organizations.slug,
        orgRole: schema.orgMemberships.role,
      })
      .from(schema.organizations)
      .leftJoin(
        schema.orgMemberships,
        and(
          eq(schema.orgMemberships.organizationId, schema.organizations.id),
          eq(schema.orgMemberships.userId, userId),
        ),
      )
      .where(eq(schema.organizations.slug, orgSlug))
      .limit(1);

    const row = rows[0];
    if (!row || row.orgRole === null) throw ApiError.notFound('Organization');

    const orgRole = row.orgRole as OrgRole;
    return {
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      orgRole,
      projectId: null,
      projectSlug: null,
      projectRole: null,
      capabilities: capabilitiesFor({ orgRole, projectRole: null }),
    };
  }

  async forProject(userId: string, orgSlug: string, projectSlug: string): Promise<AccessContext> {
    const org = await this.forOrganization(userId, orgSlug);

    const rows = await this.system.db
      .select({
        projectId: schema.projects.id,
        projectSlug: schema.projects.slug,
        projectRole: schema.projectMemberships.role,
      })
      .from(schema.projects)
      .leftJoin(
        schema.projectMemberships,
        and(
          eq(schema.projectMemberships.projectId, schema.projects.id),
          eq(schema.projectMemberships.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.projects.organizationId, org.organizationId),
          eq(schema.projects.slug, projectSlug),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw ApiError.notFound('Project');

    const projectRole = (row.projectRole as ProjectRole | null) ?? null;
    const context: AccessContext = {
      ...org,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      projectRole,
      capabilities: capabilitiesFor({ orgRole: org.orgRole, projectRole }),
    };

    // An org member with no project role and no org-level override cannot see
    // the project at all — and is told it does not exist.
    if (context.capabilities.length === 0) throw ApiError.notFound('Project');

    return context;
  }

  /** Every project the user can reach, for `GET /v1/me` and the switcher. */
  async visibleProjects(userId: string): Promise<
    Array<{
      id: string;
      slug: string;
      name: string;
      organizationId: string;
      organizationSlug: string;
      role: ProjectRole;
    }>
  > {
    const rows = await this.system.db
      .select({
        id: schema.projects.id,
        slug: schema.projects.slug,
        name: schema.projects.name,
        organizationId: schema.projects.organizationId,
        organizationSlug: schema.organizations.slug,
        orgRole: schema.orgMemberships.role,
        projectRole: schema.projectMemberships.role,
      })
      .from(schema.projects)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.projects.organizationId))
      .innerJoin(
        schema.orgMemberships,
        and(
          eq(schema.orgMemberships.organizationId, schema.projects.organizationId),
          eq(schema.orgMemberships.userId, userId),
        ),
      )
      .leftJoin(
        schema.projectMemberships,
        and(
          eq(schema.projectMemberships.projectId, schema.projects.id),
          eq(schema.projectMemberships.userId, userId),
        ),
      );

    return rows
      .map((row) => {
        const orgRole = row.orgRole as OrgRole;
        const projectRole = (row.projectRole as ProjectRole | null) ?? null;
        const effective =
          orgRole === 'owner' || orgRole === 'admin' ? ('admin' as ProjectRole) : projectRole;
        return effective
          ? {
              id: row.id,
              slug: row.slug,
              name: row.name,
              organizationId: row.organizationId,
              organizationSlug: row.organizationSlug,
              role: effective,
            }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  async organizationsFor(
    userId: string,
  ): Promise<Array<{ id: string; slug: string; name: string; role: OrgRole }>> {
    const rows = await this.system.db
      .select({
        id: schema.organizations.id,
        slug: schema.organizations.slug,
        name: schema.organizations.name,
        role: schema.orgMemberships.role,
      })
      .from(schema.orgMemberships)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.orgMemberships.organizationId),
      )
      .where(eq(schema.orgMemberships.userId, userId));

    return rows.map((row) => ({ ...row, role: row.role as OrgRole }));
  }
}
