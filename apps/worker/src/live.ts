import type IORedis from 'ioredis';
import { liveChannel, liveStreamKey, type LiveEvent } from '@eyesonbug/shared';

/**
 * Publishes live-run updates.
 *
 * Two Redis structures, each doing the job it is good at:
 *
 *  - a **stream** per run is the durable buffer. It survives a browser
 *    reconnect, which plain pub/sub cannot: a client that drops for three
 *    seconds would otherwise miss every event in that window and show stale
 *    counts until the next full refetch.
 *  - a **pub/sub channel** is only a doorbell. It tells API processes that have
 *    subscribers that there is something new to read, so no process has to poll.
 *
 * The stream is capped and expires: a live view is interesting for minutes, and
 * the run report is the durable record.
 */
export class LivePublisher {
  constructor(private readonly redis: IORedis) {}

  /** Roughly one large run's worth of events. */
  private static readonly MAX_BUFFERED = 10_000;
  /** Long enough to survive a reconnect, short enough not to accumulate. */
  private static readonly TTL_SECONDS = 2 * 60 * 60;

  async publish(runId: string, events: Array<Omit<LiveEvent, 'seq' | 'runId'>>): Promise<void> {
    if (events.length === 0) return;

    const key = liveStreamKey(runId);
    const pipeline = this.redis.pipeline();

    for (const event of events) {
      pipeline.xadd(
        key,
        'MAXLEN',
        '~',
        String(LivePublisher.MAX_BUFFERED),
        '*',
        'type',
        event.type,
        'at',
        event.at,
        'data',
        JSON.stringify(event.data),
      );
    }

    pipeline.expire(key, LivePublisher.TTL_SECONDS);
    // The doorbell carries no payload: a subscriber reads the stream, so a
    // dropped notification costs a moment of latency rather than an event.
    pipeline.publish(liveChannel(runId), '1');

    await pipeline.exec();
  }
}
