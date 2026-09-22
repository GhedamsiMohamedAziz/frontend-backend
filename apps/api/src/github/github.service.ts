import { HttpStatus, Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { TenantDb, schema } from '@eyesonbug/db';
import { GitHubApp } from '@eyesonbug/shared/node';
import { ApiError } from '../common/errors';
import { env } from '../config/env';
import { TENANT_DB } from '../database/database.module';

export interface InstallationRow {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositories: string[];
  suspendedAt: Date | null;
}

/**
 * The App is configured once per deployment; organizations *install* it.
 * This service owns the client and the "which installation does this org
 * have" lookup that every back-office route starts with.
 */
@Injectable()
export class GitHubService implements OnModuleDestroy {
  readonly app: GitHubApp | null;
  private readonly redis: IORedis;

  constructor(@Inject(TENANT_DB) private readonly tenant: TenantDb) {
    const config = env();
    this.redis = new IORedis(config.REDIS_URL, { lazyConnect: true });
    this.app =
      config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY
        ? new GitHubApp({
            appId: config.GITHUB_APP_ID,
            privateKey: config.GITHUB_APP_PRIVATE_KEY,
            apiUrl: config.GITHUB_API_URL,
          })
        : null;
  }

  /** The client, or a 503 that says exactly which variables are missing. */
  client(): GitHubApp {
    if (!this.app) {
      throw new ApiError(
        'github_not_configured',
        'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to enable the GitHub integration',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.app;
  }

  async installationFor(organizationId: string): Promise<InstallationRow | null> {
    const rows = await this.tenant.withOrg({ organizationId }, (tx) =>
      tx
        .select({
          id: schema.githubInstallations.id,
          installationId: schema.githubInstallations.installationId,
          accountLogin: schema.githubInstallations.accountLogin,
          accountType: schema.githubInstallations.accountType,
          repositories: schema.githubInstallations.repositories,
          suspendedAt: schema.githubInstallations.suspendedAt,
        })
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.organizationId, organizationId))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** An installation the org can act through, or the 404/409 that explains why not. */
  async requireInstallation(organizationId: string): Promise<InstallationRow> {
    const installation = await this.installationFor(organizationId);
    if (!installation) throw ApiError.notFound('GitHub installation');
    if (installation.suspendedAt) {
      throw ApiError.conflict('The GitHub App installation is suspended');
    }
    return installation;
  }

  /**
   * Only a repository the installation was granted may be touched. GitHub
   * treats owner and repository names case-insensitively, so we do too — and
   * return GitHub's spelling, which is what every later call must use.
   */
  assertRepoAccess(installation: InstallationRow, repoFullName: string): string {
    const wanted = repoFullName.toLowerCase();
    const match = installation.repositories.find((name) => name.toLowerCase() === wanted);
    if (!match) throw ApiError.notFound(`Repository ${repoFullName}`);
    return match;
  }

  /**
   * The GitHub user who installed the App, recorded by the worker from the
   * `installation.created` webhook (ADR-024). Linking requires the caller to
   * be that user: the App JWT can look up *any* installation, so existence on
   * GitHub proves nothing about who may act through it.
   */
  async installerOf(installationId: number): Promise<number | null> {
    const value = await this.redis.get(installerKey(installationId));
    return value ? Number(value) : null;
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}

export const INSTALLER_TTL_SECONDS = 7 * 24 * 3600;
export function installerKey(installationId: number): string {
  return `github:installer:${installationId}`;
}
