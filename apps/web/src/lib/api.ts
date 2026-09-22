import type { Capability, Me, RerunKind, WorkflowInputs } from '@eyesonbug/shared';

/**
 * All requests go through the Next rewrite at `/api/*`, so the browser sees one
 * origin and the session cookie is first-party.
 */
const BASE = '/api';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } };
    throw new ApiRequestError(
      response.status,
      body?.error?.code ?? 'error',
      body?.error?.message ?? response.statusText,
      body?.error?.details,
    );
  }

  return payload as T;
}

export const getMe = (): Promise<Me> => apiFetch<Me>('/v1/me');

export interface ProjectDetail {
  id: string;
  slug: string;
  name: string;
  repoFullName: string | null;
  defaultBranch: string;
  role: string | null;
  capabilities: Capability[];
}

export interface EnvironmentRow {
  id: string;
  name: string;
  baseUrl: string | null;
  isProduction: boolean;
}

export interface MemberRow {
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  role: string;
}

export interface TokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export const getProject = (org: string, project: string): Promise<ProjectDetail> =>
  apiFetch(`/v1/o/${org}/p/${project}`);

export const getEnvironments = (org: string, project: string): Promise<EnvironmentRow[]> =>
  apiFetch(`/v1/o/${org}/p/${project}/environments`);

export const getMembers = (org: string, project: string): Promise<MemberRow[]> =>
  apiFetch(`/v1/o/${org}/p/${project}/members`);

export const getTokens = (org: string, project: string): Promise<TokenRow[]> =>
  apiFetch(`/v1/o/${org}/p/${project}/tokens`);

export const devLogin = (email: string): Promise<{ ok: true }> =>
  apiFetch('/v1/auth/dev-login', { method: 'POST', body: JSON.stringify({ email }) });

export const logout = (): Promise<{ ok: true }> => apiFetch('/v1/auth/logout', { method: 'POST' });

export const startGithubLogin = (): Promise<{ url: string }> => apiFetch('/v1/auth/github');

// ─── Runs ───────────────────────────────────────────────────────────────────

export interface RunTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  broken: number;
  flaky: number;
  running: number;
}

export interface RunRow {
  id: string;
  number: number;
  status: string;
  trigger: string;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  buildVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  totals: RunTotals;
  environment: string | null;
}

export interface RunConfigurationRow {
  id: string;
  status: string;
  browser: string | null;
  locale: string | null;
  os: string | null;
  device: string | null;
  dimensions: Record<string, string>;
}

/** The verdict the worker wrote when the run sealed, if a gate applied. */
export interface RunGate {
  gateId: string;
  name: string;
  passed: boolean;
  reasons: string[];
}

export type RunDetail = RunRow & {
  commitAuthor: string | null;
  configurations: RunConfigurationRow[];
  githubWorkflowRunId: number | null;
  githubWorkflowName: string | null;
  githubRunAttempt: number | null;
  rerunOfRunId: string | null;
  rerunKind: RerunKind | null;
  workflowConfigId: string | null;
  dispatchInputs: Record<string, string> | null;
  gate: RunGate | null;
};

export interface FailureCluster {
  signatureId: string;
  errorType: string;
  normalizedMessage: string;
  count: number;
  affectedTests: number;
  results: Array<{
    resultId: string;
    title: string;
    fullTitle: string;
    filePath: string;
    browser: string | null;
    locale: string | null;
  }>;
}

export interface ResultRow {
  id: string;
  status: string;
  durationMs: number;
  retryIndex: number;
  errorMessage: string | null;
  testCaseId: string;
  title: string;
  fullTitle: string;
  filePath: string;
  feature: string | null;
  browser: string | null;
  locale: string | null;
}

export interface ResultDetail {
  id: string;
  status: string;
  durationMs: number;
  retryIndex: number;
  startedAt: string;
  errorType: string | null;
  errorMessage: string | null;
  stackTrace: string | null;
  testCaseId: string;
  title: string;
  fullTitle: string;
  filePath: string;
  browser: string | null;
  locale: string | null;
  attachments: Array<{ id: string; kind: string; contentType: string; sizeBytes: number }>;
  history: Array<{ id: string; status: string; startedAt: string; runNumber: number }>;
}

export const getRuns = (
  org: string,
  project: string,
  query = '',
): Promise<{ items: RunRow[]; nextCursor: string | null }> =>
  apiFetch(`/v1/o/${org}/p/${project}/runs${query ? `?${query}` : ''}`);

export const getRun = (org: string, project: string, runId: string): Promise<RunDetail> =>
  apiFetch(`/v1/o/${org}/p/${project}/runs/${runId}`);

export const getFailures = (
  org: string,
  project: string,
  runId: string,
): Promise<FailureCluster[]> => apiFetch(`/v1/o/${org}/p/${project}/runs/${runId}/failures`);

export const getResults = (
  org: string,
  project: string,
  runId: string,
  status?: string,
): Promise<ResultRow[]> =>
  apiFetch(`/v1/o/${org}/p/${project}/runs/${runId}/results${status ? `?status=${status}` : ''}`);

export const getResult = (org: string, project: string, resultId: string): Promise<ResultDetail> =>
  apiFetch(`/v1/o/${org}/p/${project}/results/${resultId}`);

/** Artifacts are fetched through the API, which authorizes then redirects. */
export const attachmentUrl = (org: string, project: string, attachmentId: string): string =>
  `/api/v1/o/${org}/p/${project}/attachments/${attachmentId}`;

export const cancelRun = (
  org: string,
  project: string,
  runId: string,
): Promise<{ status: string; githubCancelled: boolean }> =>
  apiFetch(`/v1/o/${org}/p/${project}/runs/${runId}/cancel`, { method: 'POST' });

export const rerunRun = (
  org: string,
  project: string,
  runId: string,
  kind: RerunKind,
): Promise<{ runId: string; number: number }> =>
  apiFetch(`/v1/o/${org}/p/${project}/runs/${runId}/rerun`, {
    method: 'POST',
    body: JSON.stringify({ kind }),
  });

// ─── GitHub back office ─────────────────────────────────────────────────────

export interface GithubInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositories: string[];
  suspendedAt: string | null;
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GithubWorkflow {
  id: number;
  name: string;
  file: string;
  state: string;
}

export const getInstallation = (
  org: string,
): Promise<{ installation: GithubInstallation | null }> =>
  apiFetch(`/v1/o/${org}/github/installation`);

export const getInstallUrl = (org: string): Promise<{ url: string }> =>
  apiFetch(`/v1/o/${org}/github/install-url`);

export const linkInstallation = (
  org: string,
  installationId: number,
): Promise<GithubInstallation> =>
  apiFetch(`/v1/o/${org}/github/installation`, {
    method: 'POST',
    body: JSON.stringify({ installationId }),
  });

export const unlinkInstallation = (org: string): Promise<{ ok: true }> =>
  apiFetch(`/v1/o/${org}/github/installation`, { method: 'DELETE' });

export const getGithubRepos = (org: string): Promise<GithubRepo[]> =>
  apiFetch(`/v1/o/${org}/github/repos`);

/** `repoFullName` is owner/repo; the API route takes them as two segments. */
export const getGithubWorkflows = (org: string, repoFullName: string): Promise<GithubWorkflow[]> =>
  apiFetch(`/v1/o/${org}/github/repos/${repoFullName}/workflows`);

// ─── Run templates, schedules, quality gates ────────────────────────────────

export interface WorkflowConfigRow {
  id: string;
  name: string;
  repoFullName: string;
  workflowFile: string;
  ref: string;
  inputsSchema: WorkflowInputs;
  defaultInputs: Record<string, string>;
  enabled: boolean;
}

export interface ScheduleRow {
  id: string;
  name: string;
  workflowConfigId: string;
  cron: string;
  timezone: string;
  inputs: Record<string, string>;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface QualityGateRow {
  id: string;
  name: string;
  rules: { minPassRate?: number; maxFailed?: number };
  appliesToBranches: string[];
  enabled: boolean;
}

const projectPath = (org: string, project: string): string => `/v1/o/${org}/p/${project}`;

export const getWorkflowConfigs = (org: string, project: string): Promise<WorkflowConfigRow[]> =>
  apiFetch(`${projectPath(org, project)}/workflow-configs`);

export const createWorkflowConfig = (
  org: string,
  project: string,
  body: Omit<WorkflowConfigRow, 'id' | 'inputsSchema'>,
): Promise<WorkflowConfigRow> =>
  apiFetch(`${projectPath(org, project)}/workflow-configs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const updateWorkflowConfig = (
  org: string,
  project: string,
  id: string,
  body: Partial<Omit<WorkflowConfigRow, 'id' | 'inputsSchema'>>,
): Promise<WorkflowConfigRow> =>
  apiFetch(`${projectPath(org, project)}/workflow-configs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

export const deleteWorkflowConfig = (org: string, project: string, id: string): Promise<void> =>
  apiFetch(`${projectPath(org, project)}/workflow-configs/${id}`, { method: 'DELETE' });

export const dispatchWorkflowConfig = (
  org: string,
  project: string,
  id: string,
  body: { inputs: Record<string, string>; ref?: string },
): Promise<{ runId: string; number: number; htmlUrl: string }> =>
  apiFetch(`${projectPath(org, project)}/workflow-configs/${id}/dispatch`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const getSchedules = (org: string, project: string): Promise<ScheduleRow[]> =>
  apiFetch(`${projectPath(org, project)}/schedules`);

export const createSchedule = (
  org: string,
  project: string,
  body: Omit<ScheduleRow, 'id' | 'nextRunAt' | 'lastRunAt'>,
): Promise<ScheduleRow> =>
  apiFetch(`${projectPath(org, project)}/schedules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const updateSchedule = (
  org: string,
  project: string,
  id: string,
  body: Partial<Omit<ScheduleRow, 'id' | 'nextRunAt' | 'lastRunAt'>>,
): Promise<ScheduleRow> =>
  apiFetch(`${projectPath(org, project)}/schedules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

export const deleteSchedule = (org: string, project: string, id: string): Promise<void> =>
  apiFetch(`${projectPath(org, project)}/schedules/${id}`, { method: 'DELETE' });

export const getQualityGates = (org: string, project: string): Promise<QualityGateRow[]> =>
  apiFetch(`${projectPath(org, project)}/quality-gates`);

export const createQualityGate = (
  org: string,
  project: string,
  body: Omit<QualityGateRow, 'id'>,
): Promise<QualityGateRow> =>
  apiFetch(`${projectPath(org, project)}/quality-gates`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const updateQualityGate = (
  org: string,
  project: string,
  id: string,
  body: Partial<Omit<QualityGateRow, 'id'>>,
): Promise<QualityGateRow> =>
  apiFetch(`${projectPath(org, project)}/quality-gates/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

export const deleteQualityGate = (org: string, project: string, id: string): Promise<void> =>
  apiFetch(`${projectPath(org, project)}/quality-gates/${id}`, { method: 'DELETE' });
