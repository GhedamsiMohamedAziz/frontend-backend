import { sql } from 'drizzle-orm';
import type { SystemDb } from '@eyesonbug/db';
import { logger } from '../logger';

export type MaintenanceJob =
  | { task: 'provision-partitions' }
  | { task: 'prune-sessions' }
  | { task: 'expire-attachments' }
  | { task: 'reap-stale-runs' }
  | { task: 'tick-schedules' };

/**
 * Keep partitions provisioned ahead of time.
 *
 * `test_result` is range-partitioned by month (ADR-012). A row whose timestamp
 * falls outside every partition lands in the default partition, which works but
 * plans badly — so the window is extended before it is needed rather than after
 * ingestion has already started degrading.
 */
export async function provisionPartitions(system: SystemDb, monthsAhead = 6): Promise<string[]> {
  const created: string[] = [];
  for (let month = 0; month <= monthsAhead; month += 1) {
    const result = await system.db.execute<{ ensure_test_result_partition: string }>(
      sql`select ensure_test_result_partition(now() + make_interval(months => ${month}))`,
    );
    const name = result.rows[0]?.ensure_test_result_partition;
    if (name) created.push(name);
  }

  // If anything reached the default partition, ingestion is writing outside the
  // provisioned window and someone needs to know.
  const stray = await system.db.execute<{ count: string }>(
    sql`select count(*)::text as count from test_result_default`,
  );
  const strayCount = Number(stray.rows[0]?.count ?? '0');
  if (strayCount > 0) {
    logger.warn({ strayCount }, 'rows landed in the default partition');
  }

  return created;
}

/** Expired sessions are unusable long before this; the table just gets tidied. */
export async function pruneSessions(system: SystemDb): Promise<number> {
  const result = await system.db.execute(
    sql`delete from "session" where expires_at < now() - interval '30 days'`,
  );
  return result.rowCount ?? 0;
}

/**
 * Mark artifacts whose retention window has passed. The rows are removed here;
 * deleting the S3 objects themselves arrives with real artifacts in M1.
 */
export async function expireAttachments(system: SystemDb): Promise<number> {
  const result = await system.db.execute(
    sql`delete from attachment where expires_at is not null and expires_at < now()`,
  );
  return result.rowCount ?? 0;
}

/**
 * Close out runs whose reporter stopped talking to us.
 *
 * A run is only given a verdict when it reports one, so a CI job that is
 * cancelled, killed or times out leaves its run `running` indefinitely — which
 * also means its live view never resolves. Anything with no ingest activity for
 * two hours is marked `errored`, which is the honest answer: we do not know how
 * it ended, only that it stopped.
 */
export async function reapStaleRuns(system: SystemDb): Promise<string[]> {
  const result = await system.db.execute<{ id: string }>(sql`
    update run
    set status = 'errored',
        finished_at = coalesce(finished_at, now())
    where status in ('running', 'queued')
      and coalesce(started_at, queued_at) < now() - interval '2 hours'
      and not exists (
        select 1 from ingest_event e
        where e.run_id = run.id and e.received_at > now() - interval '2 hours'
      )
    returning id
  `);

  // Same reasoning as a cancel: a test that was in flight when the reporter
  // stopped talking never reached a verdict, and must not stay `running`.
  if (result.rows.length > 0) {
    await system.db.execute(sql`
      update test_result
      set status = 'broken',
          is_final_attempt = true,
          finished_at = now(),
          error_message = coalesce(error_message, 'Run abandoned while this test was running')
      where status = 'running'
        and run_id in (
          select value::uuid
          from jsonb_array_elements_text(${JSON.stringify(result.rows.map((r) => r.id))}::jsonb)
        )
    `);
  }

  return result.rows.map((row) => row.id);
}

export async function runMaintenance(system: SystemDb, job: MaintenanceJob): Promise<void> {
  switch (job.task) {
    case 'provision-partitions': {
      const created = await provisionPartitions(system);
      logger.info({ partitions: created.length }, 'partitions provisioned');
      return;
    }
    case 'prune-sessions': {
      const removed = await pruneSessions(system);
      logger.info({ removed }, 'expired sessions pruned');
      return;
    }
    case 'expire-attachments': {
      const removed = await expireAttachments(system);
      logger.info({ removed }, 'expired attachments removed');
      return;
    }
    case 'reap-stale-runs': {
      const reaped = await reapStaleRuns(system);
      if (reaped.length > 0) logger.warn({ reaped: reaped.length }, 'stale runs marked errored');
      return;
    }
  }
}
