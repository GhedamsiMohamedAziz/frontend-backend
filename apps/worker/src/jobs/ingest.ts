import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildRunProgress, schema } from '@eyesonbug/db';
import type { SystemDb, TenantDb, Transaction } from '@eyesonbug/db';
import type {
  IngestEvent,
  LiveEvent,
  LiveResult,
  ResultStatus,
  RunStatus,
} from '@eyesonbug/shared';
import {
  buildErrorSignature,
  configurationFingerprint,
  testCaseFingerprint,
  uuidv7,
} from '@eyesonbug/shared/node';
import { logger } from '../logger';
import type { LivePublisher } from '../live';

/**
 * Turn a run's recorded events into rows.
 *
 * The API deliberately stores events without interpreting them, so everything
 * expensive happens here: resolving each test to its stable identity, giving
 * every failure an error signature, and writing results in batches. One job
 * processes one run, and it is safe to run twice — processed events are marked
 * and skipped.
 */

export interface IngestJob {
  runId: string;
}

interface PendingResult {
  id: string;
  testCaseId: string;
  runConfigurationId: string;
  startedAt: Date;
  retryIndex: number;
  wasQuarantined: boolean;
}

/**
 * Raised when another worker already holds this run.
 *
 * Thrown rather than returned so BullMQ retries with backoff: during a live run
 * batches arrive continuously, and a pass that simply gave up would leave those
 * events unprocessed until the run completed.
 */
export class RunLockedError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is already being processed`);
    this.name = 'RunLockedError';
  }
}

export async function processRun(
  system: SystemDb,
  tenant: TenantDb,
  job: IngestJob,
  live?: LivePublisher,
): Promise<{ results: number; steps: number; attachments: number }> {
  // One unscoped lookup to find out which tenant this run belongs to; every
  // read and write after this point is scoped to that organization.
  const runRows = await system.db
    .select({
      id: schema.runs.id,
      organizationId: schema.runs.organizationId,
      projectId: schema.runs.projectId,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, job.runId))
    .limit(1);

  const run = runRows[0];
  if (!run) {
    logger.warn({ runId: job.runId }, 'ingest job for a run that no longer exists');
    return { results: 0, steps: 0, attachments: 0 };
  }

  return tenant.withOrg({ organizationId: run.organizationId }, async (tx) => {
    /*
     * One worker per run at a time.
     *
     * Streaming ingestion enqueues a pass whenever a batch lands, so two passes
     * can easily overlap. Both would read the same unprocessed events and write
     * the same results twice. A transaction-scoped advisory lock serialises
     * them and is released automatically when the transaction ends, including
     * when it aborts.
     */
    const lock = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${run.id}, 0)) as locked`,
    );
    if (!lock.rows[0]?.locked) throw new RunLockedError(run.id);

    const events = await tx
      .select({
        id: schema.ingestEvents.id,
        payload: schema.ingestEvents.payload,
      })
      .from(schema.ingestEvents)
      .where(
        and(
          eq(schema.ingestEvents.runId, run.id),
          sql`${schema.ingestEvents.processedAt} is null`,
          sql`${schema.ingestEvents.failedAt} is null`,
        ),
      )
      .orderBy(schema.ingestEvents.receivedAt, schema.ingestEvents.id);

    const ctx = {
      tx,
      organizationId: run.organizationId,
      projectId: run.projectId,
      runId: run.id,
    };

    if (events.length === 0) {
      // Nothing new to fold, but the run may have ended since the last pass —
      // a cancel produces no events of its own. One guarded statement.
      const swept = await sweepAbandonedResults(ctx);
      if (swept > 0) await updateRunTotals(ctx, null, null, null);
      return { results: 0, steps: 0, attachments: 0 };
    }

    const configurations = new Map<string, string>(); // configurationRef -> run_configuration id
    const pending = new Map<string, PendingResult>(); // resultRef -> result
    /** Ids finished in this pass, for the live feed. */
    const finishedIds: string[] = [];
    const stepRows: (typeof schema.steps.$inferInsert)[] = [];
    const attachmentRows: (typeof schema.attachments.$inferInsert)[] = [];
    const touchedTestCases = new Set<string>();
    const signatureHits = new Map<string, Date>();
    const months = new Set<string>();

    let runStatus: RunStatus | null = null;
    let runStartedAt: Date | null = null;
    let runFinishedAt: Date | null = null;

    /*
     * Three passes, not one.
     *
     * Folding events in arrival order looks natural and is wrong. A zero
     * duration result — every skipped test — produces `test.started` and
     * `test.finished` with an identical timestamp, so their relative order is
     * decided by a tiebreak on a random id. When `finished` wins, the result is
     * silently dropped and the run quietly under-reports.
     *
     * Events also arrive in batches over HTTP and can be replayed by a retry,
     * so arrival order is not something the wire protocol guarantees in the
     * first place. Resolving each dependency in its own pass makes the fold
     * order-independent by construction rather than by luck.
     */
    const decoded = events
      .map((row) => ({ id: row.id, event: reviveEvent(row.payload) }))
      .filter((row): row is { id: string; event: IngestEvent } => row.event !== null);

    /*
     * The maps are seeded from the database, not from this batch.
     *
     * A run is processed in many passes while it streams, and `config.started`
     * or `test.started` arrives in exactly one of them. Rebuilding the maps
     * from the current batch alone meant every later pass failed to attach its
     * results — the run finished with nothing recorded at all. The refs are
     * therefore stored on the rows and read back here.
     */
    for (const row of await tx
      .select({ id: schema.runConfigurations.id, ref: schema.runConfigurations.ref })
      .from(schema.runConfigurations)
      .where(eq(schema.runConfigurations.runId, run.id))) {
      if (row.ref) configurations.set(row.ref, row.id);
    }

    for (const row of await tx
      .select({
        id: schema.testResults.id,
        resultRef: schema.testResults.resultRef,
        testCaseId: schema.testResults.testCaseId,
        runConfigurationId: schema.testResults.runConfigurationId,
        startedAt: schema.testResults.startedAt,
        retryIndex: schema.testResults.retryIndex,
        wasQuarantined: schema.testResults.wasQuarantined,
      })
      .from(schema.testResults)
      .where(eq(schema.testResults.runId, run.id))) {
      if (row.resultRef) pending.set(row.resultRef, { ...row, id: row.id });
    }

    // Pass 1 — configurations introduced by this batch.
    for (const { event } of decoded) {
      if (event.type !== 'config.started') continue;
      if (configurations.has(event.configurationRef)) continue;
      configurations.set(event.configurationRef, await ensureRunConfiguration(ctx, event));
    }

    // Pass 2 — test attempts introduced by this batch.
    const startedRows: (typeof schema.testResults.$inferInsert)[] = [];
    for (const { event } of decoded) {
      if (event.type !== 'test.started') continue;
      if (pending.has(event.resultRef)) continue;

      const runConfigurationId = configurations.get(event.configurationRef);
      if (!runConfigurationId) {
        // An event naming a configuration we never saw. Skipping the result is
        // better than inventing a configuration that did not run.
        logger.warn(
          { runId: run.id, ref: event.configurationRef },
          'test event for an unknown configuration',
        );
        continue;
      }

      const testCase = await ensureTestCase(ctx, event.test);
      touchedTestCases.add(testCase.id);

      const record: PendingResult = {
        id: uuidv7(),
        testCaseId: testCase.id,
        runConfigurationId,
        startedAt: event.at,
        retryIndex: event.retryIndex,
        wasQuarantined: testCase.quarantined,
      };
      pending.set(event.resultRef, record);
      months.add(monthKey(record.startedAt));

      // The row is written now, as `running`. It is the durable anchor that
      // `test.finished`, steps and attachments attach to in later passes, and
      // it is what lets the live view show what is executing right now.
      startedRows.push({
        id: record.id,
        organizationId: run.organizationId,
        projectId: run.projectId,
        runId: run.id,
        runConfigurationId,
        testCaseId: testCase.id,
        resultRef: event.resultRef,
        status: 'running',
        retryIndex: event.retryIndex,
        isFinalAttempt: true,
        durationMs: 0,
        startedAt: record.startedAt,
        wasQuarantined: testCase.quarantined,
      });
    }

    for (const month of months) {
      await tx.execute(sql`select ensure_test_result_partition(${`${month}-01`}::timestamptz)`);
    }
    await insertChunked(tx, schema.testResults, startedRows);

    // Pass 3 — everything that depends on the two maps above.
    for (const { event } of decoded) {
      switch (event.type) {
        case 'run.started':
          runStartedAt = event.startedAt;
          break;

        case 'run.finished':
          runStatus = event.status;
          runFinishedAt = event.finishedAt;
          break;

        case 'config.finished': {
          const id = configurations.get(event.configurationRef);
          if (id) {
            await tx
              .update(schema.runConfigurations)
              .set({ status: event.status, finishedAt: event.at })
              .where(eq(schema.runConfigurations.id, id));
          }
          break;
        }

        case 'test.finished': {
          const result = pending.get(event.resultRef);
          if (!result) break;

          let errorSignatureId: string | null = null;
          let normalizedStack: string | null = null;

          if (event.error) {
            const signature = buildErrorSignature(run.projectId, {
              errorType: event.error.type,
              message: event.error.message,
              stack: event.error.stack,
            });
            errorSignatureId = await ensureErrorSignature(ctx, signature, event.at);
            normalizedStack = signature.normalizedStackHead;
            signatureHits.set(errorSignatureId, event.at);
          }

          await tx
            .update(schema.testResults)
            .set({
              status: event.status,
              isFinalAttempt: event.isFinalAttempt,
              durationMs: event.durationMs,
              finishedAt: new Date(result.startedAt.getTime() + event.durationMs),
              errorType: event.error?.type ?? null,
              errorMessage: event.error?.message ?? null,
              stackTrace: event.error?.stack ?? null,
              normalizedStack,
              errorSignatureId,
            })
            .where(
              and(
                eq(schema.testResults.id, result.id),
                // Including the partition key lets Postgres prune to the one
                // partition instead of scanning every month.
                eq(schema.testResults.startedAt, result.startedAt),
              ),
            );

          finishedIds.push(result.id);
          break;
        }

        case 'step.finished': {
          const result = pending.get(event.resultRef);
          if (!result) break;
          stepRows.push({
            organizationId: run.organizationId,
            projectId: run.projectId,
            testResultId: result.id,
            path: `s${event.position}`,
            position: event.position,
            keyword: event.keyword ?? null,
            title: event.title,
            status: event.status,
            durationMs: event.durationMs,
            errorMessage: event.errorMessage ?? null,
            startedAt: event.at,
          });
          break;
        }

        case 'attachment.added': {
          const result = pending.get(event.resultRef);
          if (!result) break;
          attachmentRows.push({
            organizationId: run.organizationId,
            projectId: run.projectId,
            testResultId: result.id,
            kind: event.kind,
            s3Key: event.s3Key,
            contentType: event.contentType,
            sizeBytes: event.sizeBytes,
            sha256: event.sha256,
            createdAt: event.at,
            expiresAt: await retentionFor(ctx, event.kind, event.at),
          });
          break;
        }

        default:
          // config.started and test.started were resolved in earlier passes.
          break;
      }
    }

    // A result whose timestamp falls outside every provisioned partition would
    // land in the default partition. Provisioning first keeps the fact table
    // planning well even when CI uploads a backdated or clock-skewed run.
    for (const month of months) {
      await tx.execute(sql`select ensure_test_result_partition(${`${month}-01`}::timestamptz)`);
    }

    await insertChunked(tx, schema.steps, stepRows);
    await insertChunked(tx, schema.attachments, attachmentRows);

    for (const [signatureId, seenAt] of signatureHits) {
      await tx
        .update(schema.errorSignatures)
        .set({
          lastSeenAt: seenAt,
          occurrenceCount: sql`${schema.errorSignatures.occurrenceCount} + 1`,
        })
        .where(eq(schema.errorSignatures.id, signatureId));
    }

    await updateRunTotals(ctx, runStatus, runStartedAt, runFinishedAt);
    await refreshStats(ctx, [...touchedTestCases]);

    await tx
      .update(schema.ingestEvents)
      .set({ processedAt: new Date() })
      .where(
        inArray(
          schema.ingestEvents.id,
          events.map((event) => event.id),
        ),
      );

    if (live) {
      const progress = await buildRunProgress(ctx.tx, ctx.projectId, run.id);
      const liveResults = await loadLiveResults(ctx, finishedIds);

      await live.publish(run.id, [
        ...liveResults.map((result) => ({
          at: new Date().toISOString(),
          type: 'result.finished' as const,
          data: result,
        })),
        ...(progress
          ? [
              {
                at: new Date().toISOString(),
                type:
                  runStatus && runStatus !== 'running'
                    ? ('run.finished' as const)
                    : ('run.progress' as const),
                data: progress,
              },
            ]
          : []),
      ] as Array<Omit<LiveEvent, 'seq' | 'runId'>>);
    }

    return {
      results: finishedIds.length,
      steps: stepRows.length,
      attachments: attachmentRows.length,
    };
  });
}

/** Enough of each finished result for the live feed's failure rail. */
async function loadLiveResults(ctx: Ctx, resultIds: string[]): Promise<LiveResult[]> {
  if (resultIds.length === 0) return [];

  const rows = await ctx.tx.execute<{
    id: string;
    test_case_id: string;
    title: string;
    full_title: string;
    status: ResultStatus;
    duration_ms: number;
    configuration_id: string;
    browser: string | null;
    locale: string | null;
    error_message: string | null;
    screenshot_id: string | null;
  }>(sql`
    select
      r.id, r.test_case_id, tc.title, tc.full_title, r.status, r.duration_ms,
      rc.id as configuration_id, c.browser, c.locale, r.error_message,
      (select a.id from attachment a
        where a.test_result_id = r.id and a.kind = 'screenshot' limit 1) as screenshot_id
    from test_result r
    join test_case tc on tc.id = r.test_case_id
    join run_configuration rc on rc.id = r.run_configuration_id
    join configuration c on c.id = rc.configuration_id
    where r.status <> 'running'
      and r.id in (
        select value::uuid from jsonb_array_elements_text(${JSON.stringify(resultIds)}::jsonb)
      )
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    testCaseId: row.test_case_id,
    title: row.title,
    fullTitle: row.full_title,
    status: row.status,
    durationMs: row.duration_ms,
    configurationId: row.configuration_id,
    configurationLabel: [row.browser, row.locale].filter(Boolean).join(' · '),
    errorPreview: row.error_message ? row.error_message.split('\n')[0]!.slice(0, 200) : null,
    screenshotAttachmentId: row.screenshot_id,
  }));
}

interface Ctx {
  tx: Transaction;
  organizationId: string;
  projectId: string;
  runId: string;
}

/** Dates arrive as JSON strings; the rest of the payload is already validated. */
function reviveEvent(payload: unknown): IngestEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const event = payload as Record<string, unknown>;
  const revived = { ...event } as Record<string, unknown>;
  for (const key of ['at', 'startedAt', 'finishedAt']) {
    if (typeof revived[key] === 'string') revived[key] = new Date(revived[key] as string);
  }
  return revived as unknown as IngestEvent;
}

const monthKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

async function ensureRunConfiguration(
  ctx: Ctx,
  event: Extract<IngestEvent, { type: 'config.started' }>,
): Promise<string> {
  const config = event.configuration;
  const fingerprint = configurationFingerprint(ctx.projectId, config);

  const existing = await ctx.tx
    .select({ id: schema.configurations.id })
    .from(schema.configurations)
    .where(
      and(
        eq(schema.configurations.projectId, ctx.projectId),
        eq(schema.configurations.fingerprint, fingerprint),
      ),
    )
    .limit(1);

  let configurationId = existing[0]?.id;
  if (!configurationId) {
    const inserted = await ctx.tx
      .insert(schema.configurations)
      .values({
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        fingerprint,
        browser: config.browser ?? null,
        browserVersion: config.browserVersion ?? null,
        device: config.device ?? null,
        os: config.os ?? null,
        osVersion: config.osVersion ?? null,
        viewport: config.viewport ?? null,
        locale: config.locale ?? null,
        dimensions: config.dimensions,
      })
      .onConflictDoNothing({
        target: [schema.configurations.projectId, schema.configurations.fingerprint],
      })
      .returning({ id: schema.configurations.id });

    configurationId =
      inserted[0]?.id ??
      (
        await ctx.tx
          .select({ id: schema.configurations.id })
          .from(schema.configurations)
          .where(
            and(
              eq(schema.configurations.projectId, ctx.projectId),
              eq(schema.configurations.fingerprint, fingerprint),
            ),
          )
          .limit(1)
      )[0]!.id;
  }

  const runConfig = await ctx.tx
    .insert(schema.runConfigurations)
    .values({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      configurationId,
      ref: event.configurationRef,
      status: 'running',
      shardIndex: config.shardIndex ?? null,
      shardTotal: config.shardTotal ?? null,
      startedAt: event.at,
    })
    .returning({ id: schema.runConfigurations.id });

  return runConfig[0]!.id;
}

async function ensureTestCase(
  ctx: Ctx,
  identity: Extract<IngestEvent, { type: 'test.started' }>['test'],
): Promise<{ id: string; quarantined: boolean }> {
  const fingerprint = testCaseFingerprint({
    projectId: ctx.projectId,
    filePath: identity.filePath,
    fullTitle: identity.fullTitle,
    params: identity.params,
  });

  const existing = await ctx.tx
    .select({ id: schema.testCases.id, quarantinedAt: schema.testCases.quarantinedAt })
    .from(schema.testCases)
    .where(
      and(
        eq(schema.testCases.projectId, ctx.projectId),
        eq(schema.testCases.fingerprint, fingerprint),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await ctx.tx
      .update(schema.testCases)
      .set({ lastSeenAt: new Date(), retiredAt: null })
      .where(eq(schema.testCases.id, existing[0].id));
    return { id: existing[0].id, quarantined: existing[0].quarantinedAt !== null };
  }

  // A fingerprint nobody recognises may still be a test we already know under
  // its old name (ADR-007). An alias is how a human says so, and it has to be
  // consulted before we conclude this is a brand new test.
  const alias = await ctx.tx
    .select({ testCaseId: schema.testCaseAliases.testCaseId })
    .from(schema.testCaseAliases)
    .where(
      and(
        eq(schema.testCaseAliases.projectId, ctx.projectId),
        eq(schema.testCaseAliases.fingerprint, fingerprint),
      ),
    )
    .limit(1);

  if (alias[0]) {
    await ctx.tx
      .update(schema.testCases)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.testCases.id, alias[0].testCaseId));
    return { id: alias[0].testCaseId, quarantined: false };
  }

  const featureId = identity.feature ? await ensureFeature(ctx, identity.feature) : null;
  const suiteId = identity.suite ? await ensureSuite(ctx, identity.suite) : null;

  const inserted = await ctx.tx
    .insert(schema.testCases)
    .values({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      fingerprint,
      featureId,
      suiteId,
      filePath: identity.filePath,
      title: identity.title,
      fullTitle: identity.fullTitle,
      params: identity.params,
    })
    .onConflictDoNothing({
      target: [schema.testCases.projectId, schema.testCases.fingerprint],
    })
    .returning({ id: schema.testCases.id });

  const id =
    inserted[0]?.id ??
    (
      await ctx.tx
        .select({ id: schema.testCases.id })
        .from(schema.testCases)
        .where(
          and(
            eq(schema.testCases.projectId, ctx.projectId),
            eq(schema.testCases.fingerprint, fingerprint),
          ),
        )
        .limit(1)
    )[0]!.id;

  for (const tag of identity.tags) await linkTag(ctx, id, tag);
  return { id, quarantined: false };
}

async function ensureFeature(ctx: Ctx, key: string): Promise<string> {
  const inserted = await ctx.tx
    .insert(schema.features)
    .values({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      key,
      name: key.charAt(0).toUpperCase() + key.slice(1),
      source: 'path',
    })
    .onConflictDoNothing({ target: [schema.features.projectId, schema.features.key] })
    .returning({ id: schema.features.id });

  if (inserted[0]) return inserted[0].id;

  const existing = await ctx.tx
    .select({ id: schema.features.id })
    .from(schema.features)
    .where(and(eq(schema.features.projectId, ctx.projectId), eq(schema.features.key, key)))
    .limit(1);
  return existing[0]!.id;
}

async function ensureSuite(ctx: Ctx, name: string): Promise<string> {
  const inserted = await ctx.tx
    .insert(schema.suites)
    .values({ organizationId: ctx.organizationId, projectId: ctx.projectId, name })
    .onConflictDoNothing({ target: [schema.suites.projectId, schema.suites.name] })
    .returning({ id: schema.suites.id });

  if (inserted[0]) return inserted[0].id;

  const existing = await ctx.tx
    .select({ id: schema.suites.id })
    .from(schema.suites)
    .where(and(eq(schema.suites.projectId, ctx.projectId), eq(schema.suites.name, name)))
    .limit(1);
  return existing[0]!.id;
}

async function linkTag(ctx: Ctx, testCaseId: string, name: string): Promise<void> {
  const inserted = await ctx.tx
    .insert(schema.tags)
    .values({ organizationId: ctx.organizationId, projectId: ctx.projectId, name })
    .onConflictDoNothing({ target: [schema.tags.projectId, schema.tags.name] })
    .returning({ id: schema.tags.id });

  const tagId =
    inserted[0]?.id ??
    (
      await ctx.tx
        .select({ id: schema.tags.id })
        .from(schema.tags)
        .where(and(eq(schema.tags.projectId, ctx.projectId), eq(schema.tags.name, name)))
        .limit(1)
    )[0]?.id;

  if (!tagId) return;

  await ctx.tx
    .insert(schema.testCaseTags)
    .values({ organizationId: ctx.organizationId, testCaseId, tagId })
    .onConflictDoNothing();
}

async function ensureErrorSignature(
  ctx: Ctx,
  signature: {
    hash: string;
    errorType: string;
    normalizedMessage: string;
    normalizedStackHead: string;
  },
  seenAt: Date,
): Promise<string> {
  const inserted = await ctx.tx
    .insert(schema.errorSignatures)
    .values({
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      hash: signature.hash,
      errorType: signature.errorType,
      normalizedMessage: signature.normalizedMessage,
      normalizedStackHead: signature.normalizedStackHead,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
    .onConflictDoNothing({
      target: [schema.errorSignatures.projectId, schema.errorSignatures.hash],
    })
    .returning({ id: schema.errorSignatures.id });

  if (inserted[0]) return inserted[0].id;

  const existing = await ctx.tx
    .select({ id: schema.errorSignatures.id })
    .from(schema.errorSignatures)
    .where(
      and(
        eq(schema.errorSignatures.projectId, ctx.projectId),
        eq(schema.errorSignatures.hash, signature.hash),
      ),
    )
    .limit(1);
  return existing[0]!.id;
}

async function retentionFor(ctx: Ctx, kind: string, createdAt: Date): Promise<Date | null> {
  const rows = await ctx.tx
    .select({ keepDays: schema.retentionPolicies.keepDays })
    .from(schema.retentionPolicies)
    .where(
      and(
        eq(schema.retentionPolicies.projectId, ctx.projectId),
        eq(schema.retentionPolicies.artifactKind, kind as 'screenshot'),
      ),
    )
    .limit(1);

  const keepDays = rows[0]?.keepDays;
  return keepDays ? new Date(createdAt.getTime() + keepDays * 86_400_000) : null;
}

/**
 * Resolve results left `running` on a run that has already ended.
 *
 * Cancellation is cooperative, so a reporter can have a batch in flight when
 * the run is cancelled, and that batch creates fresh `running` rows after the
 * one-shot sweep at cancel time has finished. Running this on every pass makes
 * the race self-correcting instead of leaving a finished run for ever
 * reporting a test that is still going.
 *
 * @returns how many rows it resolved.
 */
async function sweepAbandonedResults(ctx: Ctx): Promise<number> {
  const result = await ctx.tx.execute(sql`
    update test_result
    set status = 'broken',
        is_final_attempt = true,
        finished_at = now(),
        error_message = coalesce(error_message, 'Run ended while this test was running')
    where run_id = ${ctx.runId}::uuid
      and status = 'running'
      and exists (
        select 1 from run
        where id = ${ctx.runId}::uuid
          and status in ('cancelled', 'errored', 'passed', 'failed')
      )
  `);
  return result.rowCount ?? 0;
}

async function updateRunTotals(
  ctx: Ctx,
  status: RunStatus | null,
  startedAt: Date | null,
  finishedAt: Date | null,
): Promise<void> {
  await sweepAbandonedResults(ctx);

  // Totals are counted from the rows that were actually written, not from what
  // the reporter claimed. If the two ever disagree, the stored results are the
  // thing the UI renders, so they are the thing that must be described.
  const counts = await ctx.tx
    .select({
      status: schema.testResults.status,
      count: sql<string>`count(*)::text`,
    })
    .from(schema.testResults)
    .where(
      and(eq(schema.testResults.runId, ctx.runId), eq(schema.testResults.isFinalAttempt, true)),
    )
    .groupBy(schema.testResults.status);

  const totals = { total: 0, passed: 0, failed: 0, skipped: 0, broken: 0, flaky: 0, running: 0 };
  for (const row of counts) {
    const value = Number(row.count);
    const status = row.status as ResultStatus;
    totals[status] += value;
    // `total` counts finished work. A test still executing is reported
    // separately as `running`, so progress never appears to go backwards when
    // an in-flight test resolves.
    if (status !== 'running') totals.total += value;
  }

  /*
   * A run is only given a verdict once it has reported one.
   *
   * With streaming ingestion this function runs after every batch, not just at
   * the end, and deriving "no failures yet, therefore passed" would mark a run
   * green seconds after it started — which also closes the live stream, because
   * the stream ends on a terminal status.
   */
  const resolved: RunStatus = status ?? 'running';

  await ctx.tx
    .update(schema.runs)
    .set({
      status: resolved,
      totals,
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(startedAt && finishedAt
        ? { durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()) }
        : {}),
    })
    .where(eq(schema.runs.id, ctx.runId));
}

/**
 * Recompute the 14-day stats for the tests this run touched (ADR-010).
 *
 * Only the touched slice is recomputed — a project with millions of results
 * cannot re-aggregate everything on every run — and the nightly reconciliation
 * is what heals any drift this incremental approach leaves behind.
 */
async function refreshStats(ctx: Ctx, testCaseIds: string[]): Promise<void> {
  if (testCaseIds.length === 0) return;

  await ctx.tx.execute(sql`
    insert into test_case_stats (
      test_case_id, "window", organization_id, project_id,
      runs, passed, failed, skipped, flaky_transitions, flakiness_score,
      p50_duration_ms, p95_duration_ms, last_failure_at, last_passed_at, updated_at
    )
    select
      r.test_case_id,
      '14d'::stats_window,
      ${ctx.organizationId}::uuid,
      ${ctx.projectId}::uuid,
      count(*),
      count(*) filter (where r.status = 'passed'),
      count(*) filter (where r.status in ('failed','broken')),
      count(*) filter (where r.status = 'skipped'),
      count(*) filter (where r.status = 'flaky'),
      -- A test whose only results are skipped has no scored attempts at all,
      -- so the ratio is 0/0. Coalescing to zero says "we have no evidence of
      -- flakiness", which is true; letting it be NULL would violate the
      -- column's NOT NULL and fail the whole run's ingestion.
      coalesce(
        round(
          count(*) filter (where r.status = 'flaky')::numeric
            / nullif(count(*) filter (where r.status <> 'skipped'), 0),
          4
        ),
        0
      ),
      percentile_disc(0.5) within group (order by r.duration_ms),
      percentile_disc(0.95) within group (order by r.duration_ms),
      max(r.started_at) filter (where r.status in ('failed','broken')),
      max(r.started_at) filter (where r.status = 'passed'),
      now()
    from test_result r
    where r.project_id = ${ctx.projectId}::uuid
      and r.is_final_attempt
      and r.status <> 'running'
      and r.started_at > now() - interval '14 days'
      and r.test_case_id in (
        -- Passed as JSON rather than a JS array: Drizzle interpolates an array
        -- as a record, which Postgres will not cast to uuid[].
        select value::uuid from jsonb_array_elements_text(${JSON.stringify(testCaseIds)}::jsonb)
      )
    group by r.test_case_id
    on conflict (test_case_id, "window") do update set
      runs = excluded.runs,
      passed = excluded.passed,
      failed = excluded.failed,
      skipped = excluded.skipped,
      flaky_transitions = excluded.flaky_transitions,
      flakiness_score = excluded.flakiness_score,
      p50_duration_ms = excluded.p50_duration_ms,
      p95_duration_ms = excluded.p95_duration_ms,
      last_failure_at = excluded.last_failure_at,
      last_passed_at = excluded.last_passed_at,
      updated_at = now()
  `);
}

async function insertChunked<T extends Record<string, unknown>>(
  tx: Transaction,
  table: Parameters<Transaction['insert']>[0],
  rows: T[],
  size = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (chunk.length === 0) continue;
    await tx.insert(table).values(chunk as never);
  }
}
