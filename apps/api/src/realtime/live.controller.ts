import { Controller, Get, Headers, Inject, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { TenantDb, buildRunProgress, schema } from '@eyesonbug/db';
import { TERMINAL_RUN_STATUSES } from '@eyesonbug/shared';
import { Access, AccessGuard, RequireCapability } from '../access/access.guard';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { TENANT_DB } from '../database/database.module';
import { RealtimeService } from './realtime.service';

/** Keeps proxies and load balancers from closing an idle connection. */
const HEARTBEAT_MS = 15_000;
/** Safety net in case a pub/sub doorbell is missed. */
const POLL_MS = 5_000;

@ApiTags('runs')
@Controller('v1/o/:org/p/:project')
@UseGuards(AccessGuard)
export class LiveController {
  constructor(
    private readonly realtime: RealtimeService,
    @Inject(TENANT_DB) private readonly tenant: TenantDb,
  ) {}

  /**
   * Server-Sent Events for one run (ADR-005).
   *
   * SSE rather than WebSockets because this is strictly server→client: cancel
   * and rerun are ordinary POSTs. It is plain HTTP, so it inherits the session
   * cookie, the proxy and the load balancer with no upgrade path of its own,
   * and `Last-Event-ID` gives resume for free.
   */
  @Get('runs/:runId/stream')
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Live run events (text/event-stream)' })
  async stream(
    @Access() access: AccessContext,
    @Param('runId') runId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    const snapshot = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      loadRun(tx, access.projectId!, runId),
    );
    if (!snapshot) throw ApiError.notFound('Run');

    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers responses by default, which would hold every event until
      // the connection closed — the exact opposite of a live view.
      'x-accel-buffering': 'no',
    });

    let closed = false;
    let cursor = lastEventId ?? null;

    const send = (id: string | null, type: string, data: unknown): void => {
      if (closed) return;
      if (id) raw.write(`id: ${id}\n`);
      raw.write(`event: ${type}\n`);
      raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // A viewer joining halfway needs the current state before the deltas, or
    // the counts would start from whatever happens to arrive next.
    if (!cursor) {
      send(null, 'run.progress', snapshot.progress);
      cursor = await this.realtime.tailId(runId);
    }

    let draining = false;
    const drain = async (): Promise<void> => {
      if (draining || closed) return;
      draining = true;
      try {
        const events = await this.realtime.read(runId, cursor);
        for (const event of events) {
          send(event.id, event.type, event.data);
          cursor = event.id;
          if (event.type === 'run.finished') {
            // The run is over; nothing further will arrive on this stream.
            finish();
            return;
          }
        }
      } catch {
        // A transient Redis error should not kill the connection: the poll
        // below will try again shortly.
      } finally {
        draining = false;
      }
    };

    const unsubscribe = await this.realtime.listen(runId, () => void drain());
    const poll = setInterval(() => void drain(), POLL_MS);
    const heartbeat = setInterval(() => {
      if (!closed) raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    function finish(): void {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      void unsubscribe();
      raw.end();
    }

    request.raw.on('close', finish);

    // A run that is already over gets its snapshot and an immediate close,
    // rather than a connection that waits forever for events that cannot come.
    if (TERMINAL_RUN_STATUSES.includes(snapshot.progress.status)) {
      await drain();
      finish();
      return;
    }

    await drain();
  }
}

async function loadRun(
  tx: Parameters<Parameters<TenantDb['withOrg']>[1]>[0],
  projectId: string,
  runId: string,
) {
  const rows = await tx
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, projectId)))
    .limit(1);

  if (!rows[0]) return null;
  const progress = await buildRunProgress(tx, projectId, runId);
  return progress ? { progress } : null;
}
