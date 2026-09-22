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

/**
 * Evaluate the project's quality gate for a run, once, when the run is sealed.
 *
 * Idempotent on `run.gate`: every ingest pass and every `workflow_run`
 * delivery may call this, and only the first call after the run reaches a
 * terminal status does any work. The verdict is stored first and reported to
 * GitHub second, so a GitHub outage loses the check run, not the verdict —
 * and a later pass retries the report while `github_check_run_id` is null.
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
  if (run.gate && run.githubCheckRunId) return;

  await tenant.withOrg({ organizationId: run.organizationId }, async (tx) => {
    let gate = run.gate;
    if (!gate) {
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
      if (!applicable) return;

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
        run.status === 'errored' || run.status === 'cancelled',
      );
      gate = { gateId: applicable.id, name: applicable.name, ...verdict };
      // Only the first evaluation wins; a concurrent pass sees `gate` set.
      const written = await tx
        .update(schema.runs)
        .set({ gate })
        .where(and(eq(schema.runs.id, run.id), isNull(schema.runs.gate)))
        .returning({ id: schema.runs.id });
      if (!written[0]) return;
    }

    // Report to GitHub when there is a commit to attach it to and an
    // installation that can reach the repository.
    const repo = row.configRepo ?? row.projectRepo;
    if (!github || !run.commitSha || !repo) return;
    const [installation] = await tx
      .select({
        installationId: schema.githubInstallations.installationId,
        repositories: schema.githubInstallations.repositories,
        suspendedAt: schema.githubInstallations.suspendedAt,
      })
      .from(schema.githubInstallations)
      .limit(1);
    const granted = installation?.repositories.find(
      (name) => name.toLowerCase() === repo.toLowerCase(),
    );
    if (!installation || installation.suspendedAt || !granted) return;

    const t = run.totals;
    try {
      const check = await github.createCheckRun(installation.installationId, granted, {
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
      await tx
        .update(schema.runs)
        .set({ githubCheckRunId: check.id })
        .where(eq(schema.runs.id, run.id));
    } catch (error) {
      // A rejected check (e.g. the sha is unknown to GitHub, or permissions
      // were withdrawn) is not retryable; a network fault is, on the next pass.
      if (error instanceof GitHubApiError && error.status >= 400 && error.status < 500) {
        logger.warn({ runId: run.id, status: error.status }, 'GitHub refused the check run');
        return;
      }
      throw error;
    }
  });
}
