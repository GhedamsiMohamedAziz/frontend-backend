import { randomBytes, createHmac } from 'node:crypto';
import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import type { AppRequest } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { env } from '../config/env';
import { Public } from './auth.guard';
import { AuthService } from './auth.service';
import { GithubOauthService } from './github-oauth.service';
import { SessionService } from './session.service';
import { safeEqual } from './session.service';

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const devLoginSchema = z.object({ email: z.string().email() });

const STATE_COOKIE = 'eob_oauth_state';

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly github: GithubOauthService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Get('github')
  @ApiOperation({ summary: 'Begin GitHub OAuth' })
  startGithub(@Res({ passthrough: true }) reply: FastifyReply): { url: string } {
    if (!this.github.configured) {
      throw ApiError.badRequest(
        'GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.',
      );
    }

    // Signed state, round-tripped through GitHub and compared on return. This
    // is what stops a crafted callback URL from logging a victim into someone
    // else's account.
    const nonce = randomBytes(16).toString('base64url');
    const state = `${nonce}.${sign(nonce)}`;
    void reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env().NODE_ENV === 'production',
      path: '/',
      maxAge: 600,
    });

    return { url: this.github.authorizeUrl(state) };
  }

  @Public()
  @Get('github/callback')
  @ApiOperation({ summary: 'GitHub OAuth callback' })
  async githubCallback(
    @Query(zodPipe(callbackQuerySchema)) query: z.infer<typeof callbackQuerySchema>,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const cookies = request.cookies as Record<string, string | undefined>;
    const expected = cookies[STATE_COOKIE];
    if (!expected || !safeEqual(expected, query.state) || !verifyState(query.state)) {
      throw ApiError.badRequest('Invalid OAuth state');
    }
    void reply.clearCookie(STATE_COOKIE, { path: '/' });

    const accessToken = await this.github.exchangeCode(query.code);
    const identity = await this.github.fetchIdentity(accessToken);
    const user = await this.auth.upsertGithubUser(identity);

    await this.setSession(user.id, request, reply);
    void reply.redirect(env().WEB_URL, 302);
  }

  /**
   * Development shortcut so the seeded data is usable before anyone has
   * registered a GitHub OAuth app. Gated on both `NODE_ENV=development` and an
   * explicit opt-in, and it only ever matches a user that already exists.
   */
  @Public()
  @Post('dev-login')
  @ApiExcludeEndpoint()
  async devLogin(
    @Body(zodPipe(devLoginSchema)) body: z.infer<typeof devLoginSchema>,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const config = env();
    if (config.NODE_ENV === 'production' || !config.ALLOW_DEV_LOGIN) {
      throw ApiError.notFound('Route');
    }

    const user = await this.auth.findByEmail(body.email);
    if (!user) throw ApiError.unauthorized('No seeded user with that address');

    await this.setSession(user.id, request, reply);
    return { ok: true };
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() request: AppRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const cookies = request.cookies as Record<string, string | undefined>;
    await this.sessions.revoke(cookies[env().SESSION_COOKIE_NAME]);
    void reply.clearCookie(env().SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }

  private async setSession(
    userId: string,
    request: AppRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const issued = await this.sessions.issue(userId, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });

    void reply.setCookie(env().SESSION_COOKIE_NAME, issued.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env().NODE_ENV === 'production',
      path: '/',
      expires: issued.expiresAt,
    });
  }
}

function sign(value: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(value).digest('base64url');
}

function verifyState(state: string): boolean {
  const [nonce, signature] = state.split('.');
  if (!nonce || !signature) return false;
  return safeEqual(sign(nonce), signature);
}
