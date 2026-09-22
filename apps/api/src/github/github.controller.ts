import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { TenantDb, schema } from '@eyesonbug/db';
import {
  type LinkInstallationInput,
  linkInstallationSchema,
  workflowFileSchema,
} from '@eyesonbug/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { SYSTEM_DB } from '../database/database.module';
import { SystemDb } from '@eyesonbug/db';
import { extractDispatchInputs, GitHubApiError } from '@eyesonbug/shared/node';
import { Access, AccessGuard, RequireOrgRole } from '../access/access.guard';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { env } from '../config/env';
import { TENANT_DB } from '../database/database.module';
import { GitHubService } from './github.service';

/**
 * Org-level GitHub back office: installing the App and browsing what it can
 * reach. Everything here is admin-only; a project maintainer consumes the
 * result through workflow configs.
 */
@ApiTags('github')
@Controller('v1/o/:org/github')
@UseGuards(AccessGuard)
@RequireOrgRole('admin')
export class GitHubController {
  constructor(
    private readonly github: GitHubService,
    @Inject(TENANT_DB) private readonly tenant: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: SystemDb,
  ) {}

  @Get('install-url')
  @ApiOperation({ summary: 'Where to send an admin to install the App for this org' })
  installUrl(@Access() access: AccessContext): { url: string } {
    const config = env();
    this.github.client();
    if (!config.GITHUB_APP_SLUG) {
      throw new ApiError(
        'github_not_configured',
        'Set GITHUB_APP_SLUG to build the install URL',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    // `state` comes back on the setup redirect, so the web app knows which org
    // to link the new installation to.
    return {
      url: `https://github.com/apps/${config.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(access.organizationSlug)}`,
    };
  }

  @Get('installation')
  @ApiOperation({ summary: 'The installation linked to this org, if any' })
  async installation(@Access() access: AccessContext) {
    return { installation: await this.github.installationFor(access.organizationId) };
  }

  /**
   * Link an installation after GitHub's setup redirect.
   *
   * The App JWT can describe every installation of the App, so "GitHub knows
   * this id" proves nothing. Ownership is proven by identity: the caller must
   * be the GitHub user who performed the install, as reported by the
   * `installation.created` webhook. A guessed id therefore cannot let one
   * tenant borrow another's repositories.
   */
  @Post('installation')
  @ApiOperation({ summary: 'Link a GitHub App installation to this org' })
  async link(
    @Access() access: AccessContext,
    @CurrentUser() user: SessionUser,
    @Body(zodPipe(linkInstallationSchema)) body: LinkInstallationInput,
  ) {
    const app = this.github.client();
    const [caller] = await this.system.db
      .select({ githubUserId: schema.users.githubUserId })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1);
    if (!caller?.githubUserId) {
      throw ApiError.forbidden('Sign in with GitHub to link an installation');
    }
    const installer = await this.github.installerOf(body.installationId);
    if (installer !== caller.githubUserId) {
      throw ApiError.forbidden(
        installer === null
          ? 'GitHub has not reported this installation yet. If it was installed more than a week ago, reinstall the App.'
          : 'Only the GitHub user who installed the App can link it',
      );
    }
    const remote = await app.getInstallation(body.installationId).catch((error: unknown) => {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw ApiError.notFound('GitHub installation');
      }
      throw error;
    });
    const repos = await app.listInstallationRepos(body.installationId);

    const values = {
      organizationId: access.organizationId,
      installationId: remote.id,
      accountLogin: remote.account.login,
      accountType: remote.account.type,
      repositories: repos.map((repo) => repo.full_name),
      suspendedAt: remote.suspended_at ? new Date(remote.suspended_at) : null,
      updatedAt: new Date(),
    };

    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      // One installation per org. Re-linking (e.g. after reinstall) replaces it.
      await tx
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.organizationId, access.organizationId));
      const [row] = await tx
        .insert(schema.githubInstallations)
        .values(values)
        .onConflictDoNothing({ target: schema.githubInstallations.installationId })
        .returning({ id: schema.githubInstallations.id });
      if (!row) throw ApiError.conflict('This installation is linked to another organization');
      return { id: row.id, ...values };
    });
  }

  @Delete('installation')
  @ApiOperation({ summary: 'Unlink the installation (does not uninstall the App on GitHub)' })
  async unlink(@Access() access: AccessContext): Promise<{ ok: true }> {
    await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.organizationId, access.organizationId)),
    );
    return { ok: true };
  }

  @Get('repos')
  @ApiOperation({ summary: 'Repositories the installation can reach' })
  async repos(@Access() access: AccessContext) {
    const installation = await this.github.requireInstallation(access.organizationId);
    const repos = await this.github.client().listInstallationRepos(installation.installationId);
    return repos.map((repo) => ({
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
    }));
  }

  @Get('repos/:owner/:repo/workflows')
  @ApiOperation({ summary: 'Workflows in a repository' })
  async workflows(
    @Access() access: AccessContext,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ) {
    const installation = await this.github.requireInstallation(access.organizationId);
    const fullName = this.github.assertRepoAccess(installation, `${owner}/${repo}`);
    const workflows = await this.github
      .client()
      .listWorkflows(installation.installationId, fullName);
    return workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      // GitHub addresses a workflow by its file name; the path is what we store.
      file: workflow.path.replace(/^\.github\/workflows\//, ''),
      state: workflow.state,
    }));
  }

  /**
   * The `workflow_dispatch.inputs` block of a workflow file, which generates
   * the launcher form. `dispatchable: false` means the workflow has no
   * `workflow_dispatch` trigger at all and cannot be run from here.
   */
  @Get('repos/:owner/:repo/workflows/:file/inputs')
  @ApiOperation({ summary: 'Parsed workflow_dispatch inputs of a workflow' })
  async inputs(
    @Access() access: AccessContext,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('file') file: string,
  ) {
    const parsedFile = workflowFileSchema.safeParse(file);
    if (!parsedFile.success)
      throw ApiError.badRequest('Expected a workflow file name such as e2e.yml');
    const installation = await this.github.requireInstallation(access.organizationId);
    const fullName = this.github.assertRepoAccess(installation, `${owner}/${repo}`);
    const source = await this.github
      .client()
      .getFile(
        installation.installationId,
        fullName,
        `.github/workflows/${parsedFile.data}`,
        'HEAD',
      );
    let doc: unknown;
    try {
      doc = parseYaml(source);
    } catch {
      throw ApiError.conflict(`${file} is not valid YAML`);
    }
    const inputs = extractDispatchInputs(doc);
    return { dispatchable: inputs !== null, inputs: inputs ?? {} };
  }
}
