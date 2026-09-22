import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or, gt } from 'drizzle-orm';
import { SystemDb, schema } from '@eyesonbug/db';
import { capabilitiesFor } from '@eyesonbug/shared';
import { hashApiToken } from '@eyesonbug/shared/node';
import { ApiError } from '../common/errors';
import type { AppRequest } from '../common/request-context';
import { SYSTEM_DB } from '../database/database.module';

/**
 * Authenticates CI, not people.
 *
 * A token is bound to exactly one project, so unlike a user session there is
 * nothing to choose: the token *is* the tenant context. Tokens are stored as
 * SHA-256 hashes, so the lookup is by hash and a database dump yields nothing
 * replayable.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(@Inject(SYSTEM_DB) private readonly system: SystemDb) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Provide a project ingest token as a bearer token');
    }

    const secret = header.slice('Bearer '.length).trim();
    const rows = await this.system.db
      .select({
        tokenId: schema.apiTokens.id,
        organizationId: schema.apiTokens.organizationId,
        organizationSlug: schema.organizations.slug,
        projectId: schema.apiTokens.projectId,
        projectSlug: schema.projects.slug,
        scopes: schema.apiTokens.scopes,
      })
      .from(schema.apiTokens)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.apiTokens.organizationId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.apiTokens.projectId))
      .where(
        and(
          eq(schema.apiTokens.tokenHash, hashApiToken(secret)),
          isNull(schema.apiTokens.revokedAt),
          or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, new Date())),
        ),
      )
      .limit(1);

    const token = rows[0];
    if (!token || !token.projectId) throw ApiError.unauthorized('Invalid or expired token');
    if (!token.scopes.includes('ingest:write')) {
      throw ApiError.forbidden('This token does not have the ingest:write scope');
    }

    request.tokenId = token.tokenId;
    request.access = {
      organizationId: token.organizationId,
      organizationSlug: token.organizationSlug,
      // A token carries no human role. It gets the project capabilities of a
      // QA user, which is the least privilege that covers ingestion, and it is
      // never allowed near organization administration.
      orgRole: null,
      projectId: token.projectId,
      projectSlug: token.projectSlug,
      projectRole: 'qa',
      capabilities: capabilitiesFor({ orgRole: null, projectRole: 'qa' }),
    };

    // Best effort: a failure to record usage must never reject a CI upload.
    void this.system.db
      .update(schema.apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiTokens.id, token.tokenId))
      .catch(() => undefined);

    return true;
  }
}
