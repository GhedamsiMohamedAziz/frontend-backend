import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';

/**
 * The API's side of the queue: it only ever produces.
 *
 * Ingestion returns 202 and defers the write (ADR-008) so a 20k-result run can
 * never slow down or fail a customer's CI job because our database is busy.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: IORedis;
  private readonly queues = new Map<string, Queue>();

  constructor() {
    this.connection = new IORedis(env().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Queue a processing pass for a run.
   *
   * Deliberately no custom `jobId`. A deterministic id looks like useful
   * deduplication and is a trap: once such a job lands in the failed set its id
   * is taken, and every later pass for that run is silently discarded. During a
   * live run a pass is enqueued per batch, so that would strand the whole run.
   *
   * Concurrency is handled where it belongs instead — the worker takes a
   * Postgres advisory lock per run, and processing is idempotent, so extra
   * passes are cheap no-ops rather than duplicate writes.
   */
  async enqueueIngest(runId: string): Promise<void> {
    await this.queue('ingest').add('process-run', { runId });
  }

  /** A verified webhook delivery, processed off the request path. */
  async enqueueGithubEvent(job: {
    event: string;
    deliveryId: string;
    payload: unknown;
  }): Promise<void> {
    await this.queue('github').add(job.event, job);
  }

  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close();
    this.connection.disconnect();
  }
}
