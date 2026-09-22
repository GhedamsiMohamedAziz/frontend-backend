import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';

/**
 * The queue topology, declared in one place so producers (the API) and
 * consumers (this worker) cannot disagree about a queue's name or its retry
 * policy.
 */
export const QUEUE_NAMES = {
  ingest: 'ingest',
  rollup: 'rollup',
  github: 'github',
  notify: 'notify',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function createRedis(): IORedis {
  return new IORedis(config().REDIS_URL, {
    // BullMQ blocks on Redis, so it must not have its own retry ceiling.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * Exponential backoff with a bounded retry count. Ingestion in particular must
 * survive a transient database blip without dropping a CI job's results, but a
 * job that fails deterministically has to reach the dead-letter set rather than
 * retry forever.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

export function createQueue(name: QueueName, connection: IORedis): Queue {
  return new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
}
