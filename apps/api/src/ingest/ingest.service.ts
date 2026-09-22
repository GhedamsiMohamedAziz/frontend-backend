import { extname } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { TenantDb, buildRunProgress, schema } from '@eyesonbug/db';
import type { IngestEvent } from '@eyesonbug/shared';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { env } from '../config/env';
import { TENANT_DB } from '../database/database.module';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { S3Service } from '../storage/s3.service';
import type { OpenRunInput, PresignAttachmentsInput } from './ingest.dto';

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/har+json': '.har',
};

@Injectable()
export class IngestService {
  constructor(
    @Inject(TENANT_DB) private readonly tenant: TenantDb,
    private readonly s3: S3Service,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Open a run, or return the one this key already opened.
   *
   * CI retries are routine — a runner dies, someone clicks "re-run failed
   * jobs" — and each retry replays the same request. The idempotency ledger
   * turns the second attempt into a lookup instead of a duplicate run.
   */
  async openRun(
    access: AccessContext,
    input: OpenRunInput,
    idempotencyKey: string,
    tokenId: string | undefined,
  ): Promise<{ runId: string; number: number; url: string }> {
    const projectId = access.projectId!;

    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const existing = await tx
        .select({ payload: schema.ingestEvents.payload, runId: schema.ingestEvents.runId })
        .from(schema.ingestEvents)
        .where(
          and(
            eq(schema.ingestEvents.projectId, projectId),
            eq(schema.ingestEvents.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);

      if (existing[0]?.runId) {
        const payload = existing[0].payload as { number?: number };
        return {
          runId: existing[0].runId,
          number: payload.number ?? 0,
          url: this.runUrl(access, existing[0].runId),
        };
      }

      // A run we dispatched ourselves already has a row, keyed by the GitHub
      // workflow run id: the reporter inside that job adopts it rather than
      // opening a second one.
      if (input.githubWorkflowRunId) {
        const dispatched = await tx
          .select({ id: schema.runs.id, number: schema.runs.number })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.projectId, projectId),
              eq(schema.runs.githubWorkflowRunId, input.githubWorkflowRunId),
              inArray(schema.runs.status, ['queued', 'running']),
              sql`${schema.runs.totals}->>'total' = '0'`,
            ),
          )
          .orderBy(desc(schema.runs.queuedAt))
          .limit(1);
        if (dispatched[0]) {
          await tx
            .update(schema.runs)
            .set({
              status: 'running',
              startedAt: new Date(),
              branch: input.branch ?? undefined,
              commitSha: input.commitSha ?? undefined,
              commitMessage: input.commitMessage ?? undefined,
              commitAuthor: input.commitAuthor ?? undefined,
              buildVersion: input.buildVersion ?? undefined,
              githubWorkflowName: input.githubWorkflowName ?? undefined,
              githubRunAttempt: input.githubRunAttempt ?? undefined,
              triggeredByTokenId: tokenId ?? null,
            })
            .where(eq(schema.runs.id, dispatched[0].id));
          await tx.insert(schema.ingestEvents).values({
            organizationId: access.organizationId,
            projectId,
            idempotencyKey,
            runId: dispatched[0].id,
            kind: 'run.open',
            payload: { number: dispatched[0].number },
            processedAt: new Date(),
          });
          return {
            runId: dispatched[0].id,
            number: dispatched[0].number,
            url: this.runUrl(access, dispatched[0].id),
          };
        }
      }

      // Per-project run numbers ("run #412") come from a counter on the project
      // row. Incrementing it inside this transaction serialises concurrent
      // openRun calls for the same project, which is exactly what we want:
      // two runs must never share a number.
      const counter = await tx
        .update(schema.projects)
        .set({ runCounter: sql`${schema.projects.runCounter} + 1` })
        .where(eq(schema.projects.id, projectId))
        .returning({ number: schema.projects.runCounter });

      const number = counter[0]?.number;
      if (number === undefined) throw ApiError.notFound('Project');

      const environmentId = input.environment
        ? ((
            await tx
              .select({ id: schema.environments.id })
              .from(schema.environments)
              .where(
                and(
                  eq(schema.environments.projectId, projectId),
                  eq(schema.environments.name, input.environment),
                ),
              )
              .limit(1)
          )[0]?.id ?? null)
        : null;

      const [run] = await tx
        .insert(schema.runs)
        .values({
          organizationId: access.organizationId,
          projectId,
          number,
          status: 'running',
          trigger: input.trigger,
          branch: input.branch ?? null,
          commitSha: input.commitSha ?? null,
          commitMessage: input.commitMessage ?? null,
          commitAuthor: input.commitAuthor ?? null,
          buildVersion: input.buildVersion ?? null,
          environmentId,
          githubWorkflowRunId: input.githubWorkflowRunId ?? null,
          githubWorkflowName: input.githubWorkflowName ?? null,
          githubRunAttempt: input.githubRunAttempt ?? null,
          triggeredByTokenId: tokenId ?? null,
          startedAt: new Date(),
        })
        .returning({ id: schema.runs.id });

      await tx.insert(schema.ingestEvents).values({
        organizationId: access.organizationId,
        projectId,
        idempotencyKey,
        runId: run!.id,
        kind: 'run.open',
        payload: { number },
        // The ledger entry for opening a run is bookkeeping, not work: mark it
        // processed so the worker does not try to replay it as an event.
        processedAt: new Date(),
      });

      return { runId: run!.id, number, url: this.runUrl(access, run!.id) };
    });
  }

  async presignAttachments(
    access: AccessContext,
    runId: string,
    input: PresignAttachmentsInput,
  ): Promise<{
    uploads: Array<{ resultRef: string; sha256: string; s3Key: string; uploadUrl: string }>;
  }> {
    await this.assertRun(access, runId);

    const uploads = await Promise.all(
      input.attachments.map(async (attachment) => {
        const extension =
          EXTENSIONS[attachment.contentType] || extname(attachment.name ?? '') || '.bin';
        const s3Key = this.s3.key(
          access.projectId!,
          runId,
          attachment.sha256,
          attachment.kind,
          extension,
        );
        return {
          resultRef: attachment.resultRef,
          sha256: attachment.sha256,
          s3Key,
          uploadUrl: await this.s3.presignUpload(s3Key, attachment.contentType),
        };
      }),
    );

    return { uploads };
  }

  /**
   * Record events for later processing.
   *
   * Nothing is interpreted here beyond validation. The request returns as soon
   * as the rows are durable, and the worker does the expensive work of
   * resolving test identities and writing results.
   */
  async acceptEvents(
    access: AccessContext,
    runId: string,
    events: IngestEvent[],
  ): Promise<{ accepted: number; duplicates: number; runStatus: string }> {
    const run = await this.assertRun(access, runId);

    const rows = events.map((event) => ({
      organizationId: access.organizationId,
      projectId: access.projectId!,
      // The event's own id is the dedupe key: a replayed batch carries the same
      // ids and collides harmlessly.
      idempotencyKey: `event:${event.eventId}`,
      runId,
      kind: event.type,
      payload: event as unknown as Record<string, unknown>,
      receivedAt: new Date(event.at),
    }));

    const inserted = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .insert(schema.ingestEvents)
        .values(rows)
        .onConflictDoNothing({
          target: [schema.ingestEvents.projectId, schema.ingestEvents.idempotencyKey],
        })
        .returning({ id: schema.ingestEvents.id }),
    );

    // Process the batch now rather than waiting for `complete`. This is what
    // makes a run watchable while it is still going: the reporter flushes every
    // second or so, and each flush becomes visible within one processing pass.
    if (inserted.length > 0) await this.queue.enqueueIngest(runId);

    // Returned so the reporter can notice a cancellation without a second
    // request on every flush.
    return {
      accepted: inserted.length,
      duplicates: rows.length - inserted.length,
      runStatus: run.status,
    };
  }

  /**
   * Cancel a run.
   *
   * This marks the run cancelled in EyesOnBug and tells the reporter to stop
   * sending. Stopping the CI job itself needs the GitHub App, which arrives in
   * M3 — until then cancellation is cooperative, and the UI says so.
   */
  async cancel(
    access: AccessContext,
    runId: string,
    userId: string,
  ): Promise<{ status: 'cancelled' }> {
    await this.tenant.withOrg({ organizationId: access.organizationId, userId }, async (tx) => {
      await tx
        .update(schema.runs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, access.projectId!)));

      await tx
        .update(schema.runConfigurations)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(
          and(
            eq(schema.runConfigurations.runId, runId),
            eq(schema.runConfigurations.status, 'running'),
          ),
        );

      /*
       * Tests that were mid-flight never reached a verdict, so they are
       * recorded as `broken` — the same treatment a runner-interrupted test
       * gets. Leaving them `running` would mean a finished run for ever
       * reported tests in progress, and they would vanish from the report,
       * which excludes in-flight rows.
       */
      await tx.execute(sql`
          update test_result
          set status = 'broken',
              is_final_attempt = true,
              finished_at = now(),
              error_message = coalesce(error_message, 'Run cancelled while this test was running')
          where run_id = ${runId}::uuid and status = 'running'
        `);

      const totals = await tx.execute<{ status: string; count: string }>(sql`
          select status, count(*)::text as count
          from test_result
          where run_id = ${runId}::uuid and is_final_attempt
          group by status
        `);
      const counted = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        broken: 0,
        flaky: 0,
        running: 0,
      };
      for (const row of totals.rows) {
        const value = Number(row.count);
        counted[row.status as keyof typeof counted] += value;
        if (row.status !== 'running') counted.total += value;
      }
      await tx.update(schema.runs).set({ totals: counted }).where(eq(schema.runs.id, runId));

      await tx.insert(schema.auditLogs).values({
        organizationId: access.organizationId,
        projectId: access.projectId,
        actorUserId: userId,
        action: 'run.cancelled',
        subjectType: 'run',
        subjectId: runId,
      });

      const progress = await buildRunProgress(tx, access.projectId!, runId);
      if (progress) {
        await this.realtime.publish(runId, [
          { type: 'run.finished', at: new Date().toISOString(), data: progress },
        ]);
      }
    });

    return { status: 'cancelled' };
  }

  async complete(access: AccessContext, runId: string): Promise<{ queued: boolean }> {
    await this.assertRun(access, runId);
    await this.queue.enqueueIngest(runId);
    return { queued: true };
  }

  async status(
    access: AccessContext,
    runId: string,
  ): Promise<{ status: string; processed: boolean; totals: Record<string, number> }> {
    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const rows = await tx
        .select({ status: schema.runs.status, totals: schema.runs.totals })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .limit(1);

      const run = rows[0];
      if (!run) throw ApiError.notFound('Run');

      const pending = await tx
        .select({ count: sql<string>`count(*)::text` })
        .from(schema.ingestEvents)
        .where(
          and(
            eq(schema.ingestEvents.runId, runId),
            sql`${schema.ingestEvents.processedAt} is null`,
            sql`${schema.ingestEvents.failedAt} is null`,
          ),
        );

      return {
        status: run.status,
        processed: Number(pending[0]?.count ?? '0') === 0,
        totals: run.totals as unknown as Record<string, number>,
      };
    });
  }

  private async assertRun(
    access: AccessContext,
    runId: string,
  ): Promise<{ id: string; status: string }> {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({ id: schema.runs.id, status: schema.runs.status })
        .from(schema.runs)
        .where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, access.projectId!)))
        .limit(1),
    );
    if (!rows[0]) throw ApiError.notFound('Run');
    return rows[0];
  }

  private runUrl(access: AccessContext, runId: string): string {
    return `${env().WEB_URL}/o/${access.organizationSlug}/p/${access.projectSlug}/runs/${runId}`;
  }
}
