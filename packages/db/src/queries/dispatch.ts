import { eq, sql } from 'drizzle-orm';
import type { RerunKind, RunTrigger } from '@eyesonbug/shared';
import { projects, runs } from '../schema/index';
import type { Transaction } from '../client';

export interface DispatchedRunInput {
  organizationId: string;
  projectId: string;
  trigger: RunTrigger;
  ref: string;
  workflowFile: string;
  githubWorkflowRunId: number;
  inputs: Record<string, string>;
  workflowConfigId: string | null;
  scheduleId?: string | null;
  triggeredByUserId?: string | null;
  rerunOfRunId?: string | null;
  rerunKind?: RerunKind | null;
}

/**
 * The Run row for a workflow we launched ourselves. Shared by the API
 * (manual dispatch, rerun) and the worker (schedules) so both allocate the
 * per-project number the same way `openRun` does: from the project counter,
 * inside the transaction, so two runs never share a number.
 */
export async function createDispatchedRun(
  tx: Transaction,
  input: DispatchedRunInput,
): Promise<{ id: string; number: number }> {
  const counter = await tx
    .update(projects)
    .set({ runCounter: sql`${projects.runCounter} + 1` })
    .where(eq(projects.id, input.projectId))
    .returning({ number: projects.runCounter });
  const number = counter[0]?.number;
  if (number === undefined) throw new Error('Project not found');

  const [run] = await tx
    .insert(runs)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      number,
      status: 'queued',
      trigger: input.trigger,
      branch: input.ref,
      githubWorkflowRunId: input.githubWorkflowRunId,
      // The webhook replaces this with the workflow's display name.
      githubWorkflowName: input.workflowFile,
      githubRunAttempt: input.rerunOfRunId ? null : 1,
      workflowConfigId: input.workflowConfigId,
      scheduleId: input.scheduleId ?? null,
      dispatchInputs: input.inputs,
      triggeredByUserId: input.triggeredByUserId ?? null,
      rerunOfRunId: input.rerunOfRunId ?? null,
      rerunKind: input.rerunKind ?? null,
    })
    .returning({ id: runs.id });
  return { id: run!.id, number };
}
