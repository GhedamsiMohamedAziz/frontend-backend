import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { schema, type SystemDb, type TenantDb } from '@eyesonbug/db';
import { TERMINAL_RUN_STATUSES, type RunStatus } from '@eyesonbug/shared';
import { logger } from '../logger';

export interface GitHubJob {
  event: string;
  deliveryId: string;
  payload: unknown;
}

interface InstallationPayload {
  action: string;
  installation: { id: number; suspended_at?: string | null };
  repositories_added?: Array<{ full_name: string }>;
  repositories_removed?: Array<{ full_name: string }>;
}

interface WorkflowRunPayload {
  action: 'requested' | 'in_progress' | 'completed';
  workflow_run: {
    id: number;
    name: string | null;
    run_attempt: number;
    status: string;
    conclusion: string | null;
    head_branch: string | null;
    head_sha: string;
    run_started_at?: string;
    updated_at: string;
    head_commit?: { message?: string; author?: { name?: string } } | null;
  };
}

/**
 * Folds a verified webhook delivery into our tables.
 *
 * Everything is keyed on GitHub's own ids (installation id, workflow run id),
 * so a redelivery is a no-op rather than a duplicate. The lookup that finds
 * which tenant a delivery belongs to runs unscoped; the write that follows
 * runs under that tenant like any other.
 */
export async function processGithubEvent(
  system: SystemDb,
  tenant: TenantDb,
  job: GitHubJob,
): Promise<void> {
  switch (job.event) {
    case 'installation':
    case 'installation_repositories':
      return onInstallation(system, tenant, job.payload as InstallationPayload);
    case 'workflow_run':
      return onWorkflowRun(system, tenant, job.payload as WorkflowRunPayload);
    default:
      logger.debug({ event: job.event, deliveryId: job.deliveryId }, 'github event ignored');
  }
}

async function onInstallation(
  system: SystemDb,
  tenant: TenantDb,
  payload: InstallationPayload,
): Promise<void> {
  const rows = await system.db
    .select({
      organizationId: schema.githubInstallations.organizationId,
      repositories: schema.githubInstallations.repositories,
    })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.installationId, payload.installation.id))
    .limit(1);
  // `created` arrives before the admin has linked the installation to an org;
  // the link itself is made through the API, which reads GitHub directly.
  const row = rows[0];
  if (!row) return;

  const where = eq(schema.githubInstallations.installationId, payload.installation.id);
  await tenant.withOrg({ organizationId: row.organizationId }, async (tx) => {
    switch (payload.action) {
      case 'deleted':
        await tx.delete(schema.githubInstallations).where(where);
        return;
      case 'suspend':
        await tx
          .update(schema.githubInstallations)
          .set({ suspendedAt: new Date(), updatedAt: new Date() })
          .where(where);
        return;
      case 'unsuspend':
        await tx
          .update(schema.githubInstallations)
          .set({ suspendedAt: null, updatedAt: new Date() })
          .where(where);
        return;
      case 'added':
      case 'removed': {
        const removed = new Set((payload.repositories_removed ?? []).map((r) => r.full_name));
        const repositories = [
          ...row.repositories.filter((name) => !removed.has(name)),
          ...(payload.repositories_added ?? [])
            .map((r) => r.full_name)
            .filter((name) => !row.repositories.includes(name)),
        ];
        await tx
          .update(schema.githubInstallations)
          .set({ repositories, updatedAt: new Date() })
          .where(where);
        return;
      }
      default:
        return;
    }
  });
}

/**
 * Keeps a Run in step with its `workflow_run`. The reporter remains the
 * authority on results; this only fills what GitHub knows and we do not —
 * branch, sha, attempt — and moves a run that never reported anything to a
 * terminal state, so a job that crashed before the reporter loaded does not
 * sit in "running" forever.
 */
async function onWorkflowRun(
  system: SystemDb,
  tenant: TenantDb,
  payload: WorkflowRunPayload,
): Promise<void> {
  const wr = payload.workflow_run;
  const rows = await system.db
    .select({
      id: schema.runs.id,
      organizationId: schema.runs.organizationId,
      status: schema.runs.status,
      totals: schema.runs.totals,
    })
    .from(schema.runs)
    .where(eq(schema.runs.githubWorkflowRunId, wr.id))
    // A rerun creates a new attempt; the newest Run row for this workflow run
    // is the one this delivery is about.
    .orderBy(sql`${schema.runs.queuedAt} desc`)
    .limit(1);
  const run = rows[0];
  if (!run) return;

  const status = nextStatus(payload, run.status, run.totals.total);
  const patch: Partial<typeof schema.runs.$inferInsert> = {
    branch: wr.head_branch,
    commitSha: wr.head_sha,
    commitMessage: wr.head_commit?.message ?? null,
    commitAuthor: wr.head_commit?.author?.name ?? null,
    githubWorkflowName: wr.name,
    githubRunAttempt: wr.run_attempt,
  };
  if (status && status !== run.status) {
    patch.status = status;
    if (status === 'running') patch.startedAt = new Date(wr.run_started_at ?? wr.updated_at);
    if (TERMINAL_RUN_STATUSES.includes(status)) patch.finishedAt = new Date(wr.updated_at);
  }

  await tenant.withOrg({ organizationId: run.organizationId }, (tx) =>
    tx
      .update(schema.runs)
      .set(patch)
      .where(
        and(
          eq(schema.runs.id, run.id),
          // Never reopen a run the reporter already sealed.
          not(inArray(schema.runs.status, [...TERMINAL_RUN_STATUSES])),
        ),
      ),
  );
}

function nextStatus(
  payload: WorkflowRunPayload,
  current: RunStatus,
  resultCount: number,
): RunStatus | null {
  if (TERMINAL_RUN_STATUSES.includes(current)) return null;
  switch (payload.action) {
    case 'in_progress':
      return current === 'queued' ? 'running' : null;
    case 'completed': {
      const conclusion = payload.workflow_run.conclusion;
      if (conclusion === 'cancelled') return 'cancelled';
      // The reporter never reached us: the job errored before or outside the
      // test step. With results in hand, the reporter's `complete` decides.
      if (resultCount === 0) return conclusion === 'success' ? 'passed' : 'errored';
      return null;
    }
    default:
      return null;
  }
}
