import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import type { WorkflowInputs } from './schemas/github.js';

/**
 * The GitHub App client (ADR-022).
 *
 * piggy: node:crypto + fetch instead of Octokit. We call eight endpoints; if
 * the surface grows past pagination-by-hand, swap the `request` core for
 * `@octokit/rest` and keep the method signatures.
 *
 * Every fact here was checked against docs.github.com on 2026-09-22:
 *  - app JWT: RS256, `iat`/`exp` (max 10 min), `iss` = app id
 *  - installation token: POST /app/installations/{id}/access_tokens, 1 hour
 *  - dispatch: POST .../actions/workflows/{id}/dispatches → 200 with
 *    `workflow_run_id`, `run_url`, `html_url`; inputs ≤ 25
 *  - cancel → 202, rerun / rerun-failed-jobs → 201, need `actions: write`
 *  - check runs → `checks: write`, GitHub Apps only
 */

export interface GitHubAppConfig {
  appId: string;
  /** PEM. Base64-encoded PEM is also accepted, for env vars that dislike newlines. */
  privateKey: string;
  /** https://api.github.com in production; a fake server in tests. */
  apiUrl?: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GitHubInstallation {
  id: number;
  account: { login: string; type: string };
  suspended_at: string | null;
  repository_selection: 'all' | 'selected';
}

export interface DispatchResult {
  workflow_run_id: number;
  run_url: string;
  html_url: string;
}

export interface CheckRunInput {
  name: string;
  head_sha: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
  details_url?: string;
  output?: { title: string; summary: string; text?: string };
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function normalizePem(key: string): string {
  return key.includes('-----BEGIN') ? key : Buffer.from(key, 'base64').toString('utf8');
}

export class GitHubApp {
  private readonly apiUrl: string;
  private readonly privateKey: string;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly config: GitHubAppConfig) {
    this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.privateKey = normalizePem(config.privateKey);
  }

  /** A short-lived JWT that authenticates *as the App* (not an installation). */
  appJwt(now = Math.floor(Date.now() / 1000)): string {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    // Backdated 60s per GitHub's guidance, to absorb clock drift.
    const payload = base64url(
      JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.config.appId }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
  }

  /** Installation tokens last one hour; refreshed five minutes early. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;

    const body = await this.request<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      { auth: `Bearer ${this.appJwt()}` },
    );
    this.tokens.set(installationId, {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime(),
    });
    return body.token;
  }

  async getInstallation(installationId: number): Promise<GitHubInstallation> {
    return this.request('GET', `/app/installations/${installationId}`, {
      auth: `Bearer ${this.appJwt()}`,
    });
  }

  async listInstallationRepos(installationId: number): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    for (let page = 1; ; page += 1) {
      const body = await this.asInstallation<{ repositories: GitHubRepo[] }>(
        installationId,
        'GET',
        `/installation/repositories?per_page=100&page=${page}`,
      );
      repos.push(...body.repositories);
      if (body.repositories.length < 100) return repos;
    }
  }

  async listWorkflows(installationId: number, repo: string): Promise<GitHubWorkflow[]> {
    const body = await this.asInstallation<{ workflows: GitHubWorkflow[] }>(
      installationId,
      'GET',
      `/repos/${repo}/actions/workflows?per_page=100`,
    );
    return body.workflows;
  }

  /** Raw file contents at a ref, via the contents API with the raw media type. */
  async getFile(installationId: number, repo: string, path: string, ref: string): Promise<string> {
    return this.asInstallation<string>(
      installationId,
      'GET',
      `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      { accept: 'application/vnd.github.raw+json' },
    );
  }

  async dispatchWorkflow(
    installationId: number,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<DispatchResult> {
    return this.asInstallation<DispatchResult>(
      installationId,
      'POST',
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      { body: { ref, inputs } },
    );
  }

  async cancelRun(installationId: number, repo: string, runId: number): Promise<void> {
    await this.asInstallation(
      installationId,
      'POST',
      `/repos/${repo}/actions/runs/${runId}/cancel`,
    );
  }

  async rerun(
    installationId: number,
    repo: string,
    runId: number,
    kind: 'all' | 'failed',
  ): Promise<void> {
    const suffix = kind === 'failed' ? 'rerun-failed-jobs' : 'rerun';
    await this.asInstallation(
      installationId,
      'POST',
      `/repos/${repo}/actions/runs/${runId}/${suffix}`,
    );
  }

  async createCheckRun(
    installationId: number,
    repo: string,
    input: CheckRunInput,
  ): Promise<{ id: number }> {
    return this.asInstallation(installationId, 'POST', `/repos/${repo}/check-runs`, {
      body: input,
    });
  }

  async updateCheckRun(
    installationId: number,
    repo: string,
    checkRunId: number,
    input: Partial<CheckRunInput>,
  ): Promise<{ id: number }> {
    return this.asInstallation(installationId, 'PATCH', `/repos/${repo}/check-runs/${checkRunId}`, {
      body: input,
    });
  }

  private async asInstallation<T>(
    installationId: number,
    method: string,
    path: string,
    options: { body?: unknown; accept?: string } = {},
  ): Promise<T> {
    const token = await this.installationToken(installationId);
    return this.request<T>(method, path, { ...options, auth: `Bearer ${token}` });
  }

  private async request<T>(
    method: string,
    path: string,
    options: { auth: string; body?: unknown; accept?: string },
  ): Promise<T> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: options.auth,
        accept: options.accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'eyesonbug',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* not JSON */
      }
      throw new GitHubApiError(response.status, path, `GitHub ${method} ${path}: ${message}`);
    }
    if (!text) return undefined as T;
    if (options.accept?.includes('raw')) return text as T;
    return JSON.parse(text) as T;
  }
}

/**
 * Webhook signature (X-Hub-Signature-256): HMAC-SHA256 of the raw body, hex,
 * prefixed `sha256=`. Compared in constant time.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer | string,
  header: string | undefined,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice('sha256='.length));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signWebhookBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Pull `on.workflow_dispatch.inputs` out of an already-parsed workflow document.
 * Returns null when the workflow cannot be dispatched at all, which the UI
 * needs to distinguish from "dispatchable with no inputs".
 */
export function extractDispatchInputs(doc: unknown): WorkflowInputs | null {
  if (!doc || typeof doc !== 'object') return null;
  // YAML parses the bare key `on` as boolean true in YAML 1.1 parsers; the
  // `yaml` package (1.2) keeps it a string. Accept both.
  const record = doc as Record<string, unknown>;
  const on = record.on ?? record.true;
  if (on === 'workflow_dispatch') return {};
  if (Array.isArray(on)) return on.includes('workflow_dispatch') ? {} : null;
  if (!on || typeof on !== 'object') return null;
  if (!('workflow_dispatch' in on)) return null;
  const dispatch = (on as Record<string, unknown>).workflow_dispatch;
  if (!dispatch || typeof dispatch !== 'object') return {};
  const inputs = (dispatch as Record<string, unknown>).inputs;
  if (!inputs || typeof inputs !== 'object') return {};

  const result: WorkflowInputs = {};
  for (const [name, raw] of Object.entries(inputs as Record<string, unknown>)) {
    const input = (raw ?? {}) as Record<string, unknown>;
    const type = input.type;
    result[name] = {
      type:
        type === 'boolean' || type === 'choice' || type === 'number' || type === 'environment'
          ? type
          : 'string',
      required: input.required === true,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(input.default !== undefined && input.default !== null
        ? { default: input.default as string | boolean | number }
        : {}),
      ...(Array.isArray(input.options) ? { options: input.options.map(String) } : {}),
    };
  }
  return result;
}
