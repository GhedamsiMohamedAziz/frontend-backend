import { and, eq, lte, sql } from 'drizzle-orm';
import { createDispatchedRun, schema, type SystemDb, type TenantDb } from '@eyesonbug/db';
import { resolveDispatchInputs, type WorkflowInputs } from '@eyesonbug/shared';
import { nextCronRun, type GitHubApp } from '@eyesonbug/shared/node';
import { logger } from '../logger';

/**
 * The schedule tick (ADR-025). Runs once a minute; every enabled schedule
 * whose `next_run_at` has passed is claimed by advancing that timestamp in
 * the same statement, so two workers ticking at once cannot both dispatch
 * it. A claimed schedule is then dispatched exactly like a manual launch.
 */
export async function tickSchedules(
  system: SystemDb,
  tenant: TenantDb,
  github: GitHubApp | null,
  now = new Date(),
): Promise<{ dispatched: number; skipped: number }> {
  const due = await system.db
    .select({
      id: schema.schedules.id,
      organizationId: schema.schedules.organizationId,
      projectId: schema.schedules.projectId,
      cron: schema.schedules.cron,
      timezone: schema.schedules.timezone,
      inputs: schema.schedules.inputs,
      nextRunAt: schema.schedules.nextRunAt,
      workflowConfigId: schema.schedules.workflowConfigId,
    })
    .from(schema.schedules)
    .where(and(eq(schema.schedules.enabled, true), lte(schema.schedules.nextRunAt, now)))
    .limit(100);

  let dispatched = 0;
  let skipped = 0;
  for (const schedule of due) {
    // The claim: only the worker whose UPDATE sees the old `next_run_at` wins.
    const next = nextCronRun(schedule.cron, schedule.timezone, now);
    const claimed = await system.db
      .update(schema.schedules)
      .set({ nextRunAt: next, lastRunAt: now })
      .where(
        and(
          eq(schema.schedules.id, schedule.id),
          eq(schema.schedules.nextRunAt, schedule.nextRunAt!),
        ),
      )
      .returning({ id: schema.schedules.id });
    if (!claimed[0]) continue;

    try {
      const ok = await dispatchSchedule(system, tenant, github, schedule);
      if (ok) dispatched += 1;
      else skipped += 1;
    } catch (error) {
      // One broken schedule must not stop the others; it is retried next time
      // its cron fires, and the failure is in the log with its id.
      skipped += 1;
      logger.error({ scheduleId: schedule.id, err: error }, 'scheduled dispatch failed');
    }
  }
  return { dispatched, skipped };
}

async function dispatchSchedule(
  system: SystemDb,
  tenant: TenantDb,
  github: GitHubApp | null,
  schedule: {
    id: string;
    organizationId: string;
    projectId: string;
    inputs: Record<string, string>;
    workflowConfigId: string;
  },
): Promise<boolean> {
  if (!github) {
    logger.warn({ scheduleId: schedule.id }, 'schedule due but the GitHub App is not configured');
    return false;
  }
  const [config] = await system.db
    .select()
    .from(schema.workflowConfigs)
    .where(eq(schema.workflowConfigs.id, schedule.workflowConfigId))
    .limit(1);
  if (!config?.enabled) return false;

  const [installation] = await system.db
    .select({
      installationId: schema.githubInstallations.installationId,
      repositories: schema.githubInstallations.repositories,
      suspendedAt: schema.githubInstallations.suspendedAt,
    })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.organizationId, schedule.organizationId))
    .limit(1);
  const repo = installation?.repositories.find(
    (name) => name.toLowerCase() === config.repoFullName.toLowerCase(),
  );
  if (!installation || installation.suspendedAt || !repo) {
    logger.warn(
      { scheduleId: schedule.id },
      'schedule due but the installation cannot reach the repo',
    );
    return false;
  }

  const { inputs, errors } = resolveDispatchInputs(
    config.inputsSchema as WorkflowInputs,
    config.defaultInputs,
    schedule.inputs,
  );
  if (errors.length) {
    logger.warn(
      { scheduleId: schedule.id, errors },
      'schedule inputs no longer match the workflow',
    );
    return false;
  }

  const result = await github.dispatchWorkflow(
    installation.installationId,
    repo,
    config.workflowFile,
    config.ref,
    inputs,
  );
  await tenant.withOrg({ organizationId: schedule.organizationId }, (tx) =>
    createDispatchedRun(tx, {
      organizationId: schedule.organizationId,
      projectId: schedule.projectId,
      trigger: 'schedule',
      ref: config.ref,
      workflowFile: config.workflowFile,
      githubWorkflowRunId: result.workflow_run_id,
      inputs,
      workflowConfigId: config.id,
      scheduleId: schedule.id,
    }),
  );
  return true;
}

/** For tests and the health endpoint: how many schedules are overdue. */
export async function overdueSchedules(system: SystemDb, now = new Date()): Promise<number> {
  const rows = await system.db
    .select({ count: sql<string>`count(*)::text` })
    .from(schema.schedules)
    .where(and(eq(schema.schedules.enabled, true), lte(schema.schedules.nextRunAt, now)));
  return Number(rows[0]?.count ?? '0');
}
