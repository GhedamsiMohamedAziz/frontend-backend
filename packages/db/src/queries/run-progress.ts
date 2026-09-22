import { eq, sql } from 'drizzle-orm';
import type { RunProgress } from '@eyesonbug/shared';
import type { Transaction } from '../client';
import { configurations, runConfigurations, runs, testResults } from '../schema/execution';

/**
 * Where a run currently stands, including an estimate of when it will finish.
 *
 * Lives here rather than in the worker because two callers need it and they
 * must agree: the worker publishes this after every batch, and the API sends
 * the same shape as the opening snapshot of an SSE connection. If the snapshot
 * and the updates were computed differently, a viewer would see the numbers
 * jump the moment the first update arrived.
 */
export async function buildRunProgress(
  tx: Transaction,
  projectId: string,
  runId: string,
): Promise<RunProgress | null> {
  const runRows = await tx
    .select({ status: runs.status, totals: runs.totals, startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  const run = runRows[0];
  if (!run) return null;

  const totals = run.totals as RunProgress['totals'];

  /*
   * The denominator comes from history: the median result count of the last few
   * completed runs. Median rather than mean so one aborted run that recorded
   * three results does not halve every future estimate.
   */
  const expected = await tx.execute<{ expected: number | null }>(sql`
    select percentile_disc(0.5) within group (order by t)::int as expected
    from (
      select (totals->>'total')::int as t
      from run
      where project_id = ${projectId}::uuid
        and id <> ${runId}::uuid
        and status in ('passed', 'failed', 'errored')
        and (totals->>'total')::int > 0
      order by started_at desc
      limit 5
    ) recent
  `);

  const expectedTotal = expected.rows[0]?.expected ?? null;
  const done = totals.total;
  const elapsedMs = run.startedAt ? Date.now() - run.startedAt.getTime() : 0;

  /*
   * The rate comes from this run's own wall clock, not from historical
   * durations, because it already accounts for however much parallelism the job
   * has today — shard count, runner size, a busy CI queue. Below a handful of
   * results the rate is dominated by start-up cost and the estimate swings
   * wildly, so it is withheld rather than shown wrong.
   */
  const etaMs =
    expectedTotal !== null && done >= 5 && done < expectedTotal && elapsedMs > 0
      ? Math.round((elapsedMs / done) * (expectedTotal - done))
      : null;

  const perConfiguration = await tx
    .select({
      id: runConfigurations.id,
      status: runConfigurations.status,
      browser: configurations.browser,
      locale: configurations.locale,
      shardIndex: runConfigurations.shardIndex,
      // Both counters are restricted to finished final attempts, so a lane can
      // never disagree with the run's own totals. Counting every attempt made
      // the lanes show failures the summary said were zero — the retried ones.
      done: sql<string>`count(${testResults.id}) filter (
        where ${testResults.isFinalAttempt} and ${testResults.status} <> 'running'
      )::text`,
      failed: sql<string>`count(${testResults.id}) filter (
        where ${testResults.isFinalAttempt} and ${testResults.status} in ('failed','broken')
      )::text`,
    })
    .from(runConfigurations)
    .innerJoin(configurations, eq(configurations.id, runConfigurations.configurationId))
    .leftJoin(testResults, eq(testResults.runConfigurationId, runConfigurations.id))
    .where(eq(runConfigurations.runId, runId))
    .groupBy(
      runConfigurations.id,
      runConfigurations.status,
      configurations.browser,
      configurations.locale,
      runConfigurations.shardIndex,
    )
    .orderBy(runConfigurations.shardIndex, configurations.browser);

  return {
    status: run.status,
    totals,
    expectedTotal,
    etaMs,
    startedAt: run.startedAt?.toISOString() ?? null,
    configurations: perConfiguration.map((row) => ({
      id: row.id,
      label:
        [row.browser, row.locale].filter(Boolean).join(' · ') ||
        (row.shardIndex !== null ? `shard ${row.shardIndex}` : 'default'),
      status: row.status,
      done: Number(row.done),
      failed: Number(row.failed),
    })),
  };
}
