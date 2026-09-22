import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type SystemDb, type TenantDb } from '@eyesonbug/db';
import {
  TERMINAL_RUN_STATUSES,
  branchMatches,
  evaluateGateRules,
  type GateRules,
} from '@eyesonbug/shared';
import { GitHubApiError, type GitHubApp } from '@eyesonbug/shared/node';
import { logger } from '../logger';

/** `github_check_run_id` while a report is in flight, or after GitHub refused one. */
const CHECK_RUN_CLAIMED = 0;

/**
 * Evaluate the project's quality gate for a run, once, when the run is sealed
 * (ADR-026).
 *
 * Every ingest pass, `workflow_run` delivery, cancel and reap may call this.
 * The verdict is written under an `IS NULL` guard in its own transaction, so
 * concurrent passes evaluate once and a GitHub outage cannot roll it back.
 * The check run is then claimed (the id column set to a sentinel) before the
 * HTTP call, so it is posted at most once; a network fault releases the claim
 * for the next pass, a refusal keeps it so we do not retry forever.
 */
export async function evaluateGate(
  system: SystemDb,
  tenant: TenantDb,
  github: GitHubApp | null,
  runId: string,
  webUrl: string,
): Promise<void> {
  const [row] = await system.db
    .select({
      run: schema.runs,
      projectSlug: schema.projects.slug,
      projectRepo: schema.projects.repoFullName,
      quarantineBlocksGate: sql<boolean>`coalesce((${schema.projects.settings}->>'quarantineBlocksGate')::boolean, false)`,
      orgSlug: schema.organizations.slug,
      configRepo: schema.workflowConfigs.repoFullName,
    })
    .from(schema.runs)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.runs.organizationId))
    .leftJoin(schema.workflowConfigs, eq(schema.workflowConfigs.id, schema.runs.workflowConfigId))
    .where(eq(schema.runs.id, runId))
    .limit(1);
  if (!row) return;
  const { run } = row;
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) return;
  if (run.githubCheckRunId !== null) return;
  const errored = run.status === 'errored' || run.status === 'cancelled';
  // A sealed run with no results and no error is a placeholder the reporter
  // never adopted (e.g. a duplicate row); a gate on nothing would be green.
  if (run.totals.total === 0 && !errored) return;

  const orgCtx = { organizationId: run.organizationId };

  // 1. The verdict, committed on its own.
  let gate = run.gate;
  if (!gate) {
    gate = await tenant.withOrg(orgCtx, async (tx) => {
      const gates = await tx
        .select()
        .from(schema.qualityGates)
        .where(
          and(
            eq(schema.qualityGates.projectId, run.projectId),
            eq(schema.qualityGates.enabled, true),
          ),
        )
        .orderBy(schema.qualityGates.name);
      const applicable = gates.find((g) => branchMatches(g.appliesToBranches, run.branch));
      if (!applicable) return null;

      const quarantined = row.quarantineBlocksGate
        ? 0
        : Number(
            (
              await tx
                .select({ count: sql<string>`count(*)::text` })
                .from(schema.testResults)
                .where(
                  and(
                    eq(schema.testResults.runId, run.id),
                    eq(schema.testResults.wasQuarantined, true),
                    inArray(schema.testResults.status, ['failed', 'broken']),
                  ),
                )
            )[0]?.count ?? '0',
          );

      const verdict = evaluateGateRules(
        applicable.rules as GateRules,
        run.totals,
        quarantined,
        errored,
      );
      const value = { gateId: applicable.id, name: applicable.name, ...verdict };
      const written = await tx
        .update(schema.runs)
        .set({ gate: value })
        .where(and(eq(schema.runs.id, run.id), isNull(schema.runs.gate)))
        .returning({ gate: schema.runs.gate });
      // Lost the race: the other pass owns the verdict and the report.
      return written[0] ? value : null;
    });
    if (!gate) return;
  }

  // 2. The report, when there is a commit to attach it to and an installation
  //    that reaches the repository.
  const repo = row.configRepo ?? row.projectRepo;
  if (!github || !run.commitSha || !repo) return;
  const target = await tenant.withOrg(orgCtx, async (tx) => {
    const [installation] = await tx
      .select({
        installationId: schema.githubInstallations.installationId,
        repositories: schema.githubInstallations.repositories,
        suspendedAt: schema.githubInstallations.suspendedAt,
      })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.organizationId, run.organizationId))
      .limit(1);
    const granted = installation?.repositories.find(
      (name) => name.toLowerCase() === repo.toLowerCase(),
    );
    if (!installation || installation.suspendedAt || !granted) return null;
    const claimed = await tx
      .update(schema.runs)
      .set({ githubCheckRunId: CHECK_RUN_CLAIMED })
      .where(and(eq(schema.runs.id, run.id), isNull(schema.runs.githubCheckRunId)))
      .returning({ id: schema.runs.id });
    return claimed[0] ? { installationId: installation.installationId, repo: granted } : null;
  });
  if (!target) return;

  const t = run.totals;
  const release = (id: number | null) =>
    tenant.withOrg(orgCtx, (tx) =>
      tx.update(schema.runs).set({ githubCheckRunId: id }).where(eq(schema.runs.id, run.id)),
    );
  try {
    const check = await github.createCheckRun(target.installationId, target.repo, {
      name: `EyesOnBug / ${gate.name}`,
      head_sha: run.commitSha,
      status: 'completed',
      conclusion: gate.passed ? 'success' : 'failure',
      details_url: `${webUrl}/o/${row.orgSlug}/p/${row.projectSlug}/runs/${run.id}`,
      output: {
        title: gate.passed ? 'Quality gate passed' : 'Quality gate failed',
        summary:
          `${t.passed} passed, ${t.failed} failed, ${t.broken} broken, ` +
          `${t.flaky} flaky, ${t.skipped} skipped` +
          (gate.reasons.length ? `\n\n- ${gate.reasons.join('\n- ')}` : ''),
      },
    });
    await release(check.id);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status >= 400 && error.status < 500) {
      // Not retryable (unknown sha, permissions withdrawn): keep the claim.
      logger.warn({ runId: run.id, status: error.status }, 'GitHub refused the check run');
      return;
    }
    await release(null);
    throw error;
  }
}
