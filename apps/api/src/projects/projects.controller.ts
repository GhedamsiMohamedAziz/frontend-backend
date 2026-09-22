import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq, isNull } from 'drizzle-orm';
import { TenantDb } from '@eyesonbug/db';
import { schema } from '@eyesonbug/db';
import {
  type Capability,
  type CreateApiTokenInput,
  type CreateEnvironmentInput,
  type CreateProjectInput,
  type UpdateProjectInput,
  createApiTokenSchema,
  createEnvironmentSchema,
  createProjectSchema,
  slugify,
  updateProjectSchema,
} from '@eyesonbug/shared';
import { hashApiToken } from '@eyesonbug/shared/node';
import { Access, AccessGuard, RequireCapability, RequireOrgRole } from '../access/access.guard';
import { AccessService } from '../access/access.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { TENANT_DB } from '../database/database.module';

@ApiTags('projects')
@Controller('v1/o/:org')
@UseGuards(AccessGuard)
export class ProjectsController {
  constructor(
    private readonly access: AccessService,
    @Inject(TENANT_DB) private readonly tenant: TenantDb,
  ) {}

  @Get('projects')
  @ApiOperation({ summary: 'Projects in this organization the caller can see' })
  async list(@CurrentUser() user: SessionUser, @Param('org') org: string) {
    const projects = await this.access.visibleProjects(user.id);
    return projects.filter((project) => project.organizationSlug === org);
  }

  @Post('projects')
  @RequireOrgRole('admin')
  @ApiOperation({ summary: 'Create a project' })
  async create(
    @CurrentUser() user: SessionUser,
    @Access() access: AccessContext,
    @Body(zodPipe(createProjectSchema)) body: CreateProjectInput,
  ): Promise<{ id: string; slug: string }> {
    const slug = body.slug ?? slugify(body.name);

    return this.tenant.withOrg(
      { organizationId: access.organizationId, userId: user.id },
      async (tx) => {
        const existing = await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.slug, slug))
          .limit(1);
        if (existing[0]) throw ApiError.conflict(`The slug "${slug}" is already used here`);

        const [project] = await tx
          .insert(schema.projects)
          .values({
            organizationId: access.organizationId,
            slug,
            name: body.name,
            repoFullName: body.repoFullName ?? null,
            defaultBranch: body.defaultBranch,
          })
          .returning({ id: schema.projects.id, slug: schema.projects.slug });

        // The creator gets an explicit project admin role rather than relying
        // on their org role, so access survives an org-role downgrade.
        await tx.insert(schema.projectMemberships).values({
          organizationId: access.organizationId,
          projectId: project!.id,
          userId: user.id,
          role: 'admin',
        });

        // Sensible defaults, so a new project is immediately usable.
        await tx.insert(schema.environments).values([
          { organizationId: access.organizationId, projectId: project!.id, name: 'staging' },
          {
            organizationId: access.organizationId,
            projectId: project!.id,
            name: 'production',
            isProduction: true,
          },
        ]);
        await tx.insert(schema.retentionPolicies).values([
          {
            organizationId: access.organizationId,
            projectId: project!.id,
            artifactKind: 'video',
            keepDays: 30,
          },
          {
            organizationId: access.organizationId,
            projectId: project!.id,
            artifactKind: 'trace',
            keepDays: 30,
          },
          {
            organizationId: access.organizationId,
            projectId: project!.id,
            artifactKind: 'screenshot',
            keepDays: 90,
          },
          {
            organizationId: access.organizationId,
            projectId: project!.id,
            artifactKind: 'log',
            keepDays: 365,
          },
          {
            organizationId: access.organizationId,
            projectId: project!.id,
            artifactKind: 'har',
            keepDays: 30,
          },
        ]);

        await tx.insert(schema.auditLogs).values({
          organizationId: access.organizationId,
          projectId: project!.id,
          actorUserId: user.id,
          action: 'project.created',
          subjectType: 'project',
          subjectId: project!.id,
          after: { slug, name: body.name },
        });

        return project!;
      },
    );
  }

  @Get('p/:project')
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Project detail, with the caller capabilities' })
  async detail(@Access() access: AccessContext): Promise<{
    id: string;
    slug: string;
    name: string;
    repoFullName: string | null;
    defaultBranch: string;
    role: string | null;
    capabilities: Capability[];
  }> {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({
          id: schema.projects.id,
          slug: schema.projects.slug,
          name: schema.projects.name,
          repoFullName: schema.projects.repoFullName,
          defaultBranch: schema.projects.defaultBranch,
        })
        .from(schema.projects)
        .where(eq(schema.projects.id, access.projectId!))
        .limit(1),
    );

    const row = rows[0];
    if (!row) throw ApiError.notFound('Project');

    // The capability list travels with the resource so the UI never has to
    // re-derive permissions or guess which buttons to disable.
    return { ...row, role: access.projectRole, capabilities: access.capabilities };
  }

  @Patch('p/:project')
  @RequireCapability('project:write')
  @ApiOperation({ summary: 'Update a project' })
  async update(
    @CurrentUser() user: SessionUser,
    @Access() access: AccessContext,
    @Body(zodPipe(updateProjectSchema)) body: UpdateProjectInput,
  ): Promise<{ ok: true }> {
    await this.tenant.withOrg(
      { organizationId: access.organizationId, userId: user.id },
      async (tx) => {
        const { archived, settings, ...rest } = body;
        await tx
          .update(schema.projects)
          .set({
            ...rest,
            ...(settings ? { settings: settings as never } : {}),
            ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
            updatedAt: new Date(),
          })
          .where(eq(schema.projects.id, access.projectId!));

        await tx.insert(schema.auditLogs).values({
          organizationId: access.organizationId,
          projectId: access.projectId,
          actorUserId: user.id,
          action: 'project.updated',
          subjectType: 'project',
          subjectId: access.projectId,
          after: body as never,
        });
      },
    );
    return { ok: true };
  }

  @Get('p/:project/members')
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Project members and their roles' })
  async members(@Access() access: AccessContext) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({
          userId: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          avatarUrl: schema.users.avatarUrl,
          role: schema.projectMemberships.role,
        })
        .from(schema.projectMemberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.projectMemberships.userId))
        .where(eq(schema.projectMemberships.projectId, access.projectId!)),
    );
  }

  @Get('p/:project/environments')
  @RequireCapability('project:read')
  async environments(@Access() access: AccessContext) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select()
        .from(schema.environments)
        .where(eq(schema.environments.projectId, access.projectId!)),
    );
  }

  @Post('p/:project/environments')
  @RequireCapability('environment:manage')
  async createEnvironment(
    @Access() access: AccessContext,
    @Body(zodPipe(createEnvironmentSchema)) body: CreateEnvironmentInput,
  ) {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .insert(schema.environments)
        .values({
          organizationId: access.organizationId,
          projectId: access.projectId!,
          name: body.name,
          baseUrl: body.baseUrl ?? null,
          isProduction: body.isProduction,
        })
        .returning(),
    );
    return rows[0];
  }

  @Get('p/:project/tokens')
  @RequireCapability('token:manage')
  @ApiOperation({ summary: 'API tokens (prefixes only — the secret is never returned)' })
  async tokens(@Access() access: AccessContext) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({
          id: schema.apiTokens.id,
          name: schema.apiTokens.name,
          tokenPrefix: schema.apiTokens.tokenPrefix,
          scopes: schema.apiTokens.scopes,
          createdAt: schema.apiTokens.createdAt,
          lastUsedAt: schema.apiTokens.lastUsedAt,
          expiresAt: schema.apiTokens.expiresAt,
        })
        .from(schema.apiTokens)
        .where(
          and(
            eq(schema.apiTokens.projectId, access.projectId!),
            isNull(schema.apiTokens.revokedAt),
          ),
        ),
    );
  }

  /**
   * Mint a CI token. The plaintext is returned exactly once, here, and only a
   * SHA-256 is stored — so a database dump yields no usable credentials, and
   * "I lost it" is answered by issuing a new one rather than recovering the old.
   */
  @Post('p/:project/tokens')
  @RequireCapability('token:manage')
  async createToken(
    @CurrentUser() user: SessionUser,
    @Access() access: AccessContext,
    @Body(zodPipe(createApiTokenSchema)) body: CreateApiTokenInput,
  ): Promise<{ id: string; token: string; expiresAt: Date | null }> {
    const secret = `eob_${randomBytes(24).toString('base64url')}`;
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 86_400_000)
      : null;

    const rows = await this.tenant.withOrg(
      { organizationId: access.organizationId, userId: user.id },
      async (tx) => {
        const inserted = await tx
          .insert(schema.apiTokens)
          .values({
            organizationId: access.organizationId,
            projectId: access.projectId!,
            name: body.name,
            tokenHash: hashApiToken(secret),
            tokenPrefix: secret.slice(0, 12),
            scopes: body.scopes,
            createdByUserId: user.id,
            expiresAt,
          })
          .returning({ id: schema.apiTokens.id });

        await tx.insert(schema.auditLogs).values({
          organizationId: access.organizationId,
          projectId: access.projectId,
          actorUserId: user.id,
          action: 'token.created',
          subjectType: 'api_token',
          subjectId: inserted[0]!.id,
          after: { name: body.name, scopes: body.scopes },
        });

        return inserted;
      },
    );

    return { id: rows[0]!.id, token: secret, expiresAt };
  }

  @Delete('p/:project/tokens/:tokenId')
  @RequireCapability('token:manage')
  async revokeToken(
    @CurrentUser() user: SessionUser,
    @Access() access: AccessContext,
    @Param('tokenId') tokenId: string,
  ): Promise<{ ok: true }> {
    await this.tenant.withOrg(
      { organizationId: access.organizationId, userId: user.id },
      async (tx) => {
        await tx
          .update(schema.apiTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(schema.apiTokens.id, tokenId),
              eq(schema.apiTokens.projectId, access.projectId!),
            ),
          );

        await tx.insert(schema.auditLogs).values({
          organizationId: access.organizationId,
          projectId: access.projectId,
          actorUserId: user.id,
          action: 'token.revoked',
          subjectType: 'api_token',
          subjectId: tokenId,
        });
      },
    );
    return { ok: true };
  }
}
