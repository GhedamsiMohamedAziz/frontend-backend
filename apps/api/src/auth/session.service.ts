import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { SystemDb } from '@eyesonbug/db';
import { schema } from '@eyesonbug/db';
import { env } from '../config/env';
import { SYSTEM_DB } from '../database/database.module';

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  locale: 'en' | 'fr';
  theme: 'light' | 'dark' | 'system';
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(@Inject(SYSTEM_DB) private readonly system: SystemDb) {}

  /**
   * Issue a session.
   *
   * The cookie holds the only copy of the secret; the database stores a SHA-256
   * of it. A dump of the session table therefore cannot be replayed as logins.
   * SHA-256 rather than a slow KDF is the right choice here: the token is 256
   * bits of CSPRNG output, so there is no low-entropy guess to slow down.
   */
  async issue(userId: string, meta: { userAgent?: string; ip?: string }): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 3_600_000);

    await this.system.db.insert(schema.sessions).values({
      userId,
      tokenHash: hashToken(token),
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      ip: meta.ip ?? null,
      expiresAt,
    });

    return { token, expiresAt };
  }

  /** Resolve a cookie value to a user, or null. Never throws on bad input. */
  async resolve(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;

    const rows = await this.system.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        avatarUrl: schema.users.avatarUrl,
        locale: schema.users.locale,
        theme: schema.users.theme,
        sessionId: schema.sessions.id,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          eq(schema.sessions.tokenHash, hashToken(token)),
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    // Best-effort activity tracking; a failure here must not fail the request.
    void this.system.db
      .update(schema.users)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.users.id, row.id))
      .catch(() => undefined);

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatarUrl,
      locale: row.locale,
      theme: row.theme,
    };
  }

  async revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.system.db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.sessions.tokenHash, hashToken(token)));
  }

  /** Housekeeping for the worker: drop sessions that expired long ago. */
  async pruneExpired(): Promise<number> {
    const result = await this.system.db.execute(
      sql`delete from "session" where expires_at < now() - interval '30 days'`,
    );
    return result.rowCount ?? 0;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare, for the places that compare secrets directly. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
