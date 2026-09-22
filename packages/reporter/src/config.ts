import { execFileSync } from 'node:child_process';

/**
 * Everything the reporter needs to describe a run.
 *
 * Resolution order is flags, then environment, then git. CI already knows the
 * branch and commit — GitHub Actions puts them in the environment — so the
 * common case is that a workflow sets one secret and nothing else.
 */
export interface ReporterConfig {
  apiUrl: string;
  token: string;
  reportPath: string;
  rootDir: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
  buildVersion?: string;
  environment?: string;
  trigger: 'manual' | 'schedule' | 'push' | 'pull_request' | 'api';
  githubWorkflowRunId?: number;
  githubWorkflowName?: string;
  githubRunAttempt?: number;
  /** Stable across retries of the same CI job, which is what makes ingest idempotent. */
  idempotencyKey: string;
  wait: boolean;
  timeoutMs: number;
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function mapTrigger(eventName: string | undefined): ReporterConfig['trigger'] {
  switch (eventName) {
    case 'push':
      return 'push';
    case 'pull_request':
    case 'pull_request_target':
      return 'pull_request';
    case 'schedule':
      return 'schedule';
    case 'workflow_dispatch':
      return 'manual';
    default:
      return eventName ? 'api' : 'manual';
  }
}

export function resolveConfig(flags: Record<string, string | boolean>): ReporterConfig {
  const env = process.env;
  const str = (key: string): string | undefined => {
    const value = flags[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const token = str('token') ?? env.EYESONBUG_TOKEN;
  if (!token) {
    throw new Error(
      'No API token. Pass --token or set EYESONBUG_TOKEN (create one in Project → Ingest tokens).',
    );
  }

  const rootDir = str('root') ?? git(['rev-parse', '--show-toplevel']) ?? process.cwd();

  /*
   * The idempotency key must be identical across retries of the *same* CI job
   * and different for a genuinely new run. GitHub's run id plus attempt number
   * is exactly that: re-running a failed job keeps the run id and bumps the
   * attempt, and "re-run all jobs" produces a new attempt too. Outside CI we
   * fall back to the commit plus a timestamp, because a developer running the
   * suite twice really does mean two runs.
   */
  const githubRunId = env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : undefined;
  const githubAttempt = env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : undefined;
  const idempotencyKey =
    str('idempotency-key') ??
    (githubRunId
      ? `gha:${githubRunId}:${githubAttempt ?? 1}`
      : `local:${git(['rev-parse', 'HEAD']) ?? 'nogit'}:${Date.now()}`);

  return {
    apiUrl: (str('url') ?? env.EYESONBUG_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
    token,
    reportPath: str('report') ?? 'playwright-report.json',
    rootDir,
    branch:
      str('branch') ??
      env.GITHUB_HEAD_REF ??
      (env.GITHUB_REF_NAME || undefined) ??
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commitSha: str('commit') ?? env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']),
    commitMessage: str('commit-message') ?? git(['log', '-1', '--pretty=%s']),
    commitAuthor: str('commit-author') ?? git(['log', '-1', '--pretty=%an']),
    buildVersion: str('build') ?? env.GITHUB_RUN_NUMBER,
    environment: str('environment') ?? env.EYESONBUG_ENVIRONMENT,
    trigger: mapTrigger(str('trigger') ?? env.GITHUB_EVENT_NAME),
    githubWorkflowRunId: githubRunId,
    githubWorkflowName: env.GITHUB_WORKFLOW,
    githubRunAttempt: githubAttempt,
    idempotencyKey,
    wait: flags['no-wait'] !== true,
    timeoutMs: Number(str('timeout') ?? 60_000),
  };
}
