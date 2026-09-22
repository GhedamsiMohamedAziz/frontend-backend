import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../config/env';
import { ApiError } from '../common/errors';

const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string().optional(),
});

const githubUserSchema = z.object({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable(),
  email: z.string().email().nullable(),
  avatar_url: z.string().url().nullable(),
});

const githubEmailsSchema = z.array(
  z.object({ email: z.string().email(), primary: z.boolean(), verified: z.boolean() }),
);

export interface GithubIdentity {
  githubUserId: number;
  login: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

@Injectable()
export class GithubOauthService {
  get configured(): boolean {
    const config = env();
    return Boolean(config.GITHUB_OAUTH_CLIENT_ID && config.GITHUB_OAUTH_CLIENT_SECRET);
  }

  /**
   * `state` is a signed, short-lived value round-tripped through GitHub and
   * compared on return. Without it, a third party can hand a victim a crafted
   * callback URL and log them into the attacker's account.
   */
  authorizeUrl(state: string): string {
    const config = env();
    const params = new URLSearchParams({
      client_id: config.GITHUB_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${config.API_URL}/v1/auth/github/callback`,
      scope: 'read:user user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const config = env();
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.GITHUB_OAUTH_CLIENT_ID,
        client_secret: config.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: `${config.API_URL}/v1/auth/github/callback`,
      }),
    });

    if (!response.ok) {
      throw ApiError.badRequest('GitHub rejected the authorization code');
    }

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw ApiError.badRequest('Unexpected response from GitHub');
    }
    return parsed.data.access_token;
  }

  async fetchIdentity(accessToken: string): Promise<GithubIdentity> {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'EyesOnBug',
    };

    const userResponse = await fetch('https://api.github.com/user', { headers });
    if (!userResponse.ok) throw ApiError.unauthorized('Could not read the GitHub profile');
    const user = githubUserSchema.parse(await userResponse.json());

    // A GitHub profile email is often null (users hide it), so fall back to the
    // verified primary address, which is what the `user:email` scope is for.
    let email = user.email;
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', { headers });
      if (emailsResponse.ok) {
        const emails = githubEmailsSchema.safeParse(await emailsResponse.json());
        if (emails.success) {
          email = emails.data.find((e) => e.primary && e.verified)?.email ?? null;
        }
      }
    }

    return {
      githubUserId: user.id,
      login: user.login,
      name: user.name ?? user.login,
      email,
      avatarUrl: user.avatar_url,
    };
  }
}
