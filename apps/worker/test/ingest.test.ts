import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { SystemDb, TenantDb, schema } from '@eyesonbug/db';
import type { IngestEvent } from '@eyesonbug/shared';
import { processRun } from '../src/jobs/ingest';

/**
 * Ingestion must not depend on the order events arrive in.
 *
 * Events are posted in batches over HTTP and can be replayed by a CI retry, so
 * arrival order is not something the protocol guarantees. The case that caught
 * this in practice is subtler: a zero-duration result — every skipped test —
 * produces `test.started` and `test.finished` with an identical timestamp, so
 * their stored order comes down to a tiebreak on a random id. When `finished`
 * sorted first, the result was silently dropped and the run under-reported.
 */
describe('ingest processing', () => {
  let system: SystemDb;
  let tenant: TenantDb;
  let organizationId: string;
  let projectId: string;
  let runId: string;

  const appUrl =
    process.env.DATABASE_URL ?? 'postgres://eyesonbug_app:eyesonbug_app@localhost:5432/eyesonbug';
  const ownerUrl =
    process.env.DATABASE_MIGRATION_URL ?? 'postgres://eyesonbug:eyesonbug@localhost:5432/eyesonbug';

  beforeAll(async () => {
    system = new SystemDb({ url: ownerUrl, max: 2 });
    tenant = new TenantDb({ url: appUrl, max: 4 });

    const rows = await system.db
      .select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
      .from(schema.projects)
      .where(eq(schema.projects.slug, 'storefront'))
      .limit(1);

    projectId = rows[0]!.id;
    organizationId = rows[0]!.organizationId;
  });

  afterAll(async () => {
    if (runId) {
      await system.db.delete(schema.runs).where(eq(schema.runs.id, runId));
    }
    await tenant.close();
    await system.close();
  });

  /** The smallest event set that exercises every dependency between events. */
  function buildEvents(): IngestEvent[] {
    const at = new Date();
    const configurationRef = 'config:test-order';

    const testEvents = (
      title: string,
      durationMs: number,
      status: 'passed' | 'skipped',
    ): IngestEvent[] => {
      const resultRef = `order-check/${title}`;
      return [
        {
          eventId: randomUUID(),
          at,
          type: 'test.started',
          configurationRef,
          resultRef,
          retryIndex: 0,
          test: {
            filePath: 'e2e/order-check.spec.ts',
            title,
            fullTitle: `Ordering > ${title}`,
            params: {},
            feature: 'ordering',
            tags: [],
          },
        },
        {
          eventId: randomUUID(),
          // Zero duration: identical timestamp to `test.started`, which is
          // exactly the case that used to lose the result.
          at: new Date(at.getTime() + durationMs),
          type: 'test.finished',
          resultRef,
          status,
          durationMs,
          isFinalAttempt: true,
        },
      ];
    };

    return [
      { eventId: randomUUID(), at, type: 'run.started', startedAt: at },
      {
        eventId: randomUUID(),
        at,
        type: 'config.started',
        configurationRef,
        configuration: {
          browser: 'chromium',
          locale: 'en-US',
          os: 'linux',
          dimensions: { project: 'ordering' },
        },
      },
      ...testEvents('a skipped test', 0, 'skipped'),
      ...testEvents('an instant test', 0, 'passed'),
      ...testEvents('a normal test', 1200, 'passed'),
      {
        eventId: randomUUID(),
        at: new Date(at.getTime() + 1200),
        type: 'run.finished',
        status: 'passed',
        finishedAt: new Date(at.getTime() + 1200),
      },
    ];
  }

  it('writes every result even when events are stored in reverse order', async () => {
    const created = await system.db
      .insert(schema.runs)
      .values({
        organizationId,
        projectId,
        number: 900_000 + Math.floor(Math.random() * 90_000),
        status: 'running',
        trigger: 'api',
        startedAt: new Date(),
      })
      .returning({ id: schema.runs.id });
    runId = created[0]!.id;

    // Reversed: the worst case for a fold that trusts arrival order, and a
    // legitimate one for a client that posts batches concurrently.
    const events = buildEvents().reverse();

    await system.db.insert(schema.ingestEvents).values(
      events.map((event) => ({
        organizationId,
        projectId,
        idempotencyKey: `test:${event.eventId}`,
        runId,
        kind: event.type,
        payload: event as unknown as Record<string, unknown>,
        // Every row shares a timestamp, so the tiebreak is the only ordering
        // signal — precisely the situation the bug needed.
        receivedAt: new Date('2026-09-22T00:00:00.000Z'),
      })),
    );

    const counts = await processRun(system, tenant, { runId });
    expect(counts.results).toBe(3);

    const stored = await system.db
      .select({ status: schema.testResults.status })
      .from(schema.testResults)
      .where(eq(schema.testResults.runId, runId));

    expect(stored).toHaveLength(3);
    expect(stored.filter((row) => row.status === 'skipped')).toHaveLength(1);
    expect(stored.filter((row) => row.status === 'passed')).toHaveLength(2);
  });

  it('counts the skipped result in the run totals', async () => {
    const rows = await system.db
      .select({ totals: schema.runs.totals, status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);

    expect(rows[0]!.totals).toMatchObject({ total: 3, passed: 2, skipped: 1 });
    expect(rows[0]!.status).toBe('passed');
  });

  it('gives a test whose results are all skipped a zero flakiness score, not null', async () => {
    // 0 scored attempts means the flakiness ratio is 0/0. A NULL there violates
    // the column's NOT NULL and fails the whole run's ingestion.
    const rows = await system.db
      .select({
        score: schema.testCaseStats.flakinessScore,
        skipped: schema.testCaseStats.skipped,
      })
      .from(schema.testCaseStats)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testCaseStats.testCaseId))
      .where(
        and(
          eq(schema.testCases.projectId, projectId),
          eq(schema.testCases.title, 'a skipped test'),
        ),
      );

    expect(rows[0]).toBeDefined();
    expect(Number(rows[0]!.score)).toBe(0);
    expect(rows[0]!.skipped).toBe(1);
  });

  it('is idempotent: reprocessing the same run adds nothing', async () => {
    const again = await processRun(system, tenant, { runId });
    expect(again.results).toBe(0);

    const count = await system.db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.testResults)
      .where(eq(schema.testResults.runId, runId));

    expect(Number(count[0]!.count)).toBe(3);
  });
});

/**
 * Streaming delivers a run in many batches, and each batch is its own
 * processing pass. The mappings a pass needs — which configuration a result
 * belongs to, which row a `test.finished` updates — are therefore established
 * in one pass and used in a later one.
 *
 * Getting this wrong is not a small bug: the first version rebuilt those maps
 * from the current batch only, so every pass after the first failed to attach
 * anything and a streamed run finished with zero results recorded.
 */
describe('streaming across processing passes', () => {
  let system: SystemDb;
  let tenant: TenantDb;
  let organizationId: string;
  let projectId: string;
  let runId: string;

  const appUrl =
    process.env.DATABASE_URL ?? 'postgres://eyesonbug_app:eyesonbug_app@localhost:5432/eyesonbug';
  const ownerUrl =
    process.env.DATABASE_MIGRATION_URL ?? 'postgres://eyesonbug:eyesonbug@localhost:5432/eyesonbug';

  const at = new Date();
  const configurationRef = 'config:stream-check';
  const resultRef = 'stream-check/result-1';

  async function deliver(events: IngestEvent[]): Promise<void> {
    await system.db.insert(schema.ingestEvents).values(
      events.map((event) => ({
        organizationId,
        projectId,
        idempotencyKey: `stream:${event.eventId}`,
        runId,
        kind: event.type,
        payload: event as unknown as Record<string, unknown>,
        receivedAt: new Date(),
      })),
    );
    await processRun(system, tenant, { runId });
  }

  beforeAll(async () => {
    system = new SystemDb({ url: ownerUrl, max: 2 });
    tenant = new TenantDb({ url: appUrl, max: 4 });

    const rows = await system.db
      .select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
      .from(schema.projects)
      .where(eq(schema.projects.slug, 'storefront'))
      .limit(1);
    projectId = rows[0]!.id;
    organizationId = rows[0]!.organizationId;

    const created = await system.db
      .insert(schema.runs)
      .values({
        organizationId,
        projectId,
        number: 800_000 + Math.floor(Math.random() * 90_000),
        status: 'running',
        trigger: 'api',
        startedAt: at,
      })
      .returning({ id: schema.runs.id });
    runId = created[0]!.id;
  });

  afterAll(async () => {
    if (runId) await system.db.delete(schema.runs).where(eq(schema.runs.id, runId));
    await tenant.close();
    await system.close();
  });

  it('records a started test as running, in its own pass', async () => {
    await deliver([
      { eventId: randomUUID(), at, type: 'run.started', startedAt: at },
      {
        eventId: randomUUID(),
        at,
        type: 'config.started',
        configurationRef,
        configuration: { browser: 'chromium', locale: 'en-US', os: 'linux', dimensions: {} },
      },
      {
        eventId: randomUUID(),
        at,
        type: 'test.started',
        configurationRef,
        resultRef,
        retryIndex: 0,
        test: {
          filePath: 'e2e/stream-check.spec.ts',
          title: 'streams across passes',
          fullTitle: 'Streaming > streams across passes',
          params: {},
          feature: 'streaming',
          tags: [],
        },
      },
    ]);

    const rows = await system.db
      .select({ status: schema.testResults.status, resultRef: schema.testResults.resultRef })
      .from(schema.testResults)
      .where(eq(schema.testResults.runId, runId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('running');
    expect(rows[0]!.resultRef).toBe(resultRef);
  });

  it('counts an in-flight test separately from finished work', async () => {
    const rows = await system.db
      .select({ totals: schema.runs.totals, status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);

    // `total` is finished work. Counting a running test in it would make
    // progress appear to go backwards when the test resolves.
    expect(rows[0]!.totals).toMatchObject({ total: 0, running: 1 });
    // And the run keeps running: a verdict is only given when one is reported.
    expect(rows[0]!.status).toBe('running');
  });

  it('finishes that same row when the result arrives in a later pass', async () => {
    await deliver([
      {
        eventId: randomUUID(),
        at: new Date(at.getTime() + 1500),
        type: 'test.finished',
        resultRef,
        status: 'failed',
        durationMs: 1500,
        isFinalAttempt: true,
        error: { message: 'AssertionError: streaming is hard', stack: '    at stream-check.ts' },
      },
    ]);

    const rows = await system.db
      .select({
        status: schema.testResults.status,
        durationMs: schema.testResults.durationMs,
        errorMessage: schema.testResults.errorMessage,
        signature: schema.testResults.errorSignatureId,
      })
      .from(schema.testResults)
      .where(eq(schema.testResults.runId, runId));

    // Updated in place, not duplicated: one attempt, one row.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.durationMs).toBe(1500);
    expect(rows[0]!.errorMessage).toContain('streaming is hard');
    // The failure was clustered even though it arrived in its own batch.
    expect(rows[0]!.signature).toBeTruthy();
  });

  it('attaches artifacts that arrive in a pass of their own', async () => {
    await deliver([
      {
        eventId: randomUUID(),
        at: new Date(at.getTime() + 1600),
        type: 'attachment.added',
        resultRef,
        kind: 'screenshot',
        s3Key: 'stream-check/failure.png',
        contentType: 'image/png',
        sizeBytes: 1234,
        sha256: 'd'.repeat(64),
      },
    ]);

    const rows = await system.db
      .select({ kind: schema.attachments.kind })
      .from(schema.attachments)
      .innerJoin(schema.testResults, eq(schema.testResults.id, schema.attachments.testResultId))
      .where(eq(schema.testResults.runId, runId));

    expect(rows.map((row) => row.kind)).toEqual(['screenshot']);
  });

  it('resolves in-flight results once the run reaches a terminal state', async () => {
    const secondRef = 'stream-check/result-2';
    await deliver([
      {
        eventId: randomUUID(),
        at: new Date(at.getTime() + 1700),
        type: 'test.started',
        configurationRef,
        resultRef: secondRef,
        retryIndex: 0,
        test: {
          filePath: 'e2e/stream-check.spec.ts',
          title: 'never finishes',
          fullTitle: 'Streaming > never finishes',
          params: {},
          feature: 'streaming',
          tags: [],
        },
      },
    ]);

    // The run ends while that test is still in flight — a cancel, or a runner
    // that died. Its row must not stay `running` for ever.
    await system.db
      .update(schema.runs)
      .set({ status: 'cancelled' })
      .where(eq(schema.runs.id, runId));
    await processRun(system, tenant, { runId });

    const rows = await system.db
      .select({ status: schema.testResults.status })
      .from(schema.testResults)
      .where(eq(schema.testResults.runId, runId));

    expect(rows.filter((row) => row.status === 'running')).toHaveLength(0);
    expect(rows.filter((row) => row.status === 'broken')).toHaveLength(1);

    const run = await system.db
      .select({ totals: schema.runs.totals })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    expect(run[0]!.totals).toMatchObject({ running: 0, total: 2 });
  });
});
