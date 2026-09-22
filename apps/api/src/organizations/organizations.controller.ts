import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { SystemDb, TenantDb } from '@eyesonbug/db';
import { schema } from '@eyesonbug/db';
import {
  type CreateOrganizationInput,
  createOrganizationSchema,
  type OrgRole,
  slugify,
} from '@eyesonbug/shared';
import { Access, AccessGuard, RequireOrgRole } from '../access/access.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { SYSTEM_DB, TENANT_DB } from '../database/database.module';
import { AccessService } from '../access/access.service';

@ApiTags('organizations')
@Controller('v1')
@UseGuards(AccessGuard)
export class OrganizationsController {
  constructor(
    private readonly access: AccessService,
    @Inject(SYSTEM_DB) private readonly system: SystemDb,
    @Inject(TENANT_DB) private readonly tenant: TenantDb,
  ) {}

  @Get('orgs')
  @ApiOperation({ summary: 'Organizations the current user belongs to' })
  async list(
    @CurrentUser() user: SessionUser,
  ): Promise<Array<{ id: string; slug: string; name: string; role: OrgRole }>> {
    return this.access.organizationsFor(user.id);
  }

  /**
   * Creating an organization runs on the system handle: the row being inserted
   * *is* the tenant, so there is no tenant context to scope it to yet. The
   * creator becomes its owner in the same transaction — an organization with
   * no owner would be unadministrable.
   */
  @Post('orgs')
  @ApiOperation({ summary: 'Create an organization' })
  async create(
    @CurrentUser() user: SessionUser,
    @Body(zodPipe(createOrganizationSchema)) body: CreateOrganizationInput,
  ): Promise<{ id: string; slug: string }> {
    const slug = body.slug ?? slugify(body.name);

    return this.system.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, slug))
        .limit(1);
      if (existing[0]) throw ApiError.conflict(`The slug "${slug}" is already taken`);

      const [org] = await tx
        .insert(schema.organizations)
        .values({ slug, name: body.name })
        .returning({ id: schema.organizations.id, slug: schema.organizations.slug });

      await tx
        .insert(schema.orgMemberships)
        .values({ organizationId: org!.id, userId: user.id, role: 'owner' });

      await tx.insert(schema.auditLogs).values({
        organizationId: org!.id,
        actorUserId: user.id,
        action: 'organization.created',
        subjectType: 'organization',
        subjectId: org!.id,
        after: { slug, name: body.name },
      });

      return org!;
    });
  }

  @Get('o/:org')
  @ApiOperation({ summary: 'Organization detail' })
  async detail(
    @Access() access: AccessContext,
  ): Promise<{ id: string; slug: string; name: string; role: OrgRole | null }> {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({
          id: schema.organizations.id,
          slug: schema.organizations.slug,
          name: schema.organizations.name,
        })
        .from(schema.organizations)
        .limit(1),
    );
    const row = rows[0];
    if (!row) throw ApiError.notFound('Organization');
    return { ...row, role: access.orgRole };
  }

  @Get('o/:org/members')
  @RequireOrgRole('member')
  @ApiOperation({ summary: 'Organization members' })
  async members(@Access() access: AccessContext, @Param('org') _org: string) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({
          userId: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          avatarUrl: schema.users.avatarUrl,
          role: schema.orgMemberships.role,
        })
        .from(schema.orgMemberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.orgMemberships.userId))
        .where(and(eq(schema.orgMemberships.organizationId, access.organizationId))),
    );
  }
}
