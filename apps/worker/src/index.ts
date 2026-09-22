import { createServer } from 'node:http';
import { Worker, type Job } from 'bullmq';
import { SystemDb, TenantDb } from '@eyesonbug/db';
import { config } from './config';
import { logger } from './logger';
import { QUEUE_NAMES, createQueue, createRedis } from './queues';
import { runMaintenance, type MaintenanceJob } from './jobs/maintenance';
import { processRun, RunLockedError, type IngestJob } from './jobs/ingest';
import { processGithubEvent, type GitHubJob } from './jobs/github';
import { LivePublisher } from './live';

/**
 * The background worker.
 *
 * At M0 it owns scheduled maintenance only: keeping partitions provisioned,
 * pruning sessions, and expiring artifacts. The ingest, rollup, github and
 * notify queues are declared here but have no processors yet — they arrive with
 * the milestones that need them. Declaring them now means the API can enqueue
 * against a topology that already exists.
 */
async function main(): Promise<void> {
  const cfg = config();
  const connection = createRedis();
  const system = new SystemDb({ url: cfg.DATABASE_MIGRATION_URL, max: 4 });
  // Ingestion writes tenant data, so it goes through the RLS-bound role like
  // everything else. `system` is only used to look up which tenant a run
  // belongs to before that context exists.
  const tenant = new TenantDb({ url: cfg.DATABASE_URL, max: cfg.WORKER_CONCURRENCY + 2 });

  const maintenanceQueue = createQueue(QUEUE_NAMES.maintenance, connection);
  // A separate connection: publishing must not queue behind BullMQ's blocking
  // reads on the shared one.
  const live = new LivePublisher(createRedis());

  const ingestWorker = new Worker<IngestJob>(
    QUEUE_NAMES.ingest,
    async (job: Job<IngestJob>) => {
      const started = Date.now();
      const counts = await processRun(system, tenant, job.data, live);
      // A live run enqueues a pass per batch, and the last few are usually
      // empty. Only log passes that actually wrote something.
      if (counts.results > 0) {
        logger.info(
          { runId: job.data.runId, ...counts, ms: Date.now() - started },
          'batch ingested',
        );
      }
    },
    { connection, concurrency: cfg.WORKER_CONCURRENCY },
  );

  ingestWorker.on('failed', (job, error) => {
    // Losing the race for a run's lock is expected during a live run, not a
    // fault: BullMQ retries with backoff and the next pass picks the events up.
    if (error instanceof RunLockedError) {
      logger.debug({ runId: job?.data.runId }, 'run locked, will retry');
      return;
    }
    logger.error({ jobId: job?.id, runId: job?.data.runId, err: error }, 'ingest job failed');
  });

  const githubWorker = new Worker<GitHubJob>(
    QUEUE_NAMES.github,
    async (job: Job<GitHubJob>) => {
      await processGithubEvent(system, tenant, job.data);
    },
    { connection, concurrency: 4 },
  );

  githubWorker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, event: job?.data.event, deliveryId: job?.data.deliveryId, err: error },
      'github job failed',
    );
  });

  const maintenanceWorker = new Worker<MaintenanceJob>(
    QUEUE_NAMES.maintenance,
    async (job: Job<MaintenanceJob>) => {
      await runMaintenance(system, job.data);
    },
    { connection, concurrency: 2 },
  );

  maintenanceWorker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, task: job?.data.task, err: error }, 'maintenance job failed');
  });

  // Repeatable jobs are keyed by name, so re-registering on every boot updates
  // the schedule rather than accumulating duplicates.
  await maintenanceQueue.upsertJobScheduler(
    'nightly-partitions',
    { pattern: '0 2 * * *' },
    { name: 'provision-partitions', data: { task: 'provision-partitions' } },
  );
  await maintenanceQueue.upsertJobScheduler(
    'nightly-sessions',
    { pattern: '15 2 * * *' },
    { name: 'prune-sessions', data: { task: 'prune-sessions' } },
  );
  await maintenanceQueue.upsertJobScheduler(
    'stale-runs',
    { pattern: '*/10 * * * *' },
    { name: 'reap-stale-runs', data: { task: 'reap-stale-runs' } },
  );
  await maintenanceQueue.upsertJobScheduler(
    'hourly-attachments',
    { pattern: '30 * * * *' },
    { name: 'expire-attachments', data: { task: 'expire-attachments' } },
  );

  // Provision partitions immediately at boot: a fresh deployment should not
  // have to wait until 02:00 for its first month of partitions to exist.
  await maintenanceQueue.add('provision-partitions', { task: 'provision-partitions' });

  const health = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) }));
      return;
    }
    if (request.url === '/ready') {
      const ready =
        maintenanceWorker.isRunning() && ingestWorker.isRunning() && githubWorker.isRunning();
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'degraded' }));
      return;
    }
    response.writeHead(404).end();
  });
  health.listen(cfg.WORKER_HEALTH_PORT);

  logger.info(
    { port: cfg.WORKER_HEALTH_PORT, queues: Object.values(QUEUE_NAMES) },
    'EyesOnBug worker started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // Close the worker first so in-flight jobs finish before the pools go away;
    // a job killed mid-transaction would have to be retried from scratch.
    await ingestWorker.close();
    await githubWorker.close();
    await maintenanceWorker.close();
    await maintenanceQueue.close();
    await tenant.close();
    await system.close();
    connection.disconnect();
    health.close();
    process.exitCode = 0;
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('EyesOnBug worker failed to start:');
  console.error(error);
  logger.fatal({ err: error }, 'failed to start');
  process.exitCode = 1;
});
