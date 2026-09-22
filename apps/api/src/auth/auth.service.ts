import { Inject, Injectable } from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
import { SystemDb } from '@eyesonbug/db';
import { schema } from '@eyesonbug/db';
import { SYSTEM_DB } from '../database/database.module';
import type { GithubIdentity } from './github-oauth.service';

@Injectable()
export class AuthService {
  constructor(@Inject(SYSTEM_DB) private readonly system: SystemDb) {}

  /**
   * Find or create the user behind a GitHub identity.
   *
   * This is the identity bootstrap, and one of exactly two places that runs
   * without tenant scoping (the other is migrations). It has to: at this point
   * we do not yet know who the caller is, so there is no organization to scope
   * to. Nothing here reads or writes tenant data — only the `user` row.
   */
  async upsertGithubUser(identity: GithubIdentity): Promise<{ id: string }> {
    const existing = await this.system.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        identity.email
          ? or(
              eq(schema.users.githubUserId, identity.githubUserId),
              eq(schema.users.email, identity.email),
            )
          : eq(schema.users.githubUserId, identity.githubUserId),
      )
      .limit(1);

    if (existing[0]) {
      await this.system.db
        .update(schema.users)
        .set({
          githubUserId: identity.githubUserId,
          githubLogin: identity.login,
          name: identity.name,
          avatarUrl: identity.avatarUrl,
          ...(identity.email ? { email: identity.email } : {}),
        })
        .where(eq(schema.users.id, existing[0].id));
      return existing[0];
    }

    const [created] = await this.system.db
      .insert(schema.users)
      .values({
        githubUserId: identity.githubUserId,
        githubLogin: identity.login,
        name: identity.name,
        email: identity.email,
        avatarUrl: identity.avatarUrl,
      })
      .returning({ id: schema.users.id });

    return created!;
  }

  /** Development only: resolve a seeded user by email, for `dev-login`. */
  async findByEmail(email: string): Promise<{ id: string } | null> {
    const rows = await this.system.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    return rows[0] ?? null;
  }
}
