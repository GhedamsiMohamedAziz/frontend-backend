import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { liveChannel, liveStreamKey, type LiveEvent } from '@eyesonbug/shared';
import { env } from '../config/env';

export interface BufferedEvent {
  /** The Redis stream id. Doubles as the SSE `id:`, so resume is free. */
  id: string;
  type: LiveEvent['type'];
  at: string;
  data: unknown;
}

/**
 * The API's side of the live pipeline: it only ever reads.
 *
 * One Redis subscriber for the whole process, not one per viewer. Ten people
 * watching the same run share a single subscription; the doorbell wakes the
 * process once and every listener reads the same stream.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly subscriber: IORedis;
  private readonly reader: IORedis;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    const url = env().REDIS_URL;
    this.subscriber = new IORedis(url, { maxRetriesPerRequest: null });
    this.reader = new IORedis(url, { maxRetriesPerRequest: null });

    this.subscriber.on('message', (channel: string) => {
      const runId = channel.slice('live:notify:'.length);
      for (const notify of this.listeners.get(runId) ?? []) notify();
    });
  }

  /**
   * Register interest in a run. Returns an unsubscribe function.
   *
   * The Redis subscription is opened on the first listener and closed after the
   * last one leaves, so an idle API process holds no subscriptions at all.
   */
  async listen(runId: string, onNotify: () => void): Promise<() => Promise<void>> {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
      await this.subscriber.subscribe(liveChannel(runId));
    }
    set.add(onNotify);

    return async () => {
      set!.delete(onNotify);
      if (set!.size === 0) {
        this.listeners.delete(runId);
        await this.subscriber.unsubscribe(liveChannel(runId)).catch(() => undefined);
      }
    };
  }

  /**
   * Everything buffered after `afterId`.
   *
   * `(` makes the range exclusive, which is what turns a `Last-Event-ID` into
   * "carry on from where I was" without re-delivering the event the client
   * already applied.
   */
  async read(runId: string, afterId: string | null): Promise<BufferedEvent[]> {
    const start = afterId ? `(${afterId}` : '-';
    const entries = (await this.reader.xrange(liveStreamKey(runId), start, '+')) as Array<
      [string, string[]]
    >;

    return entries.map(([id, fields]) => {
      const record: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) record[fields[i]!] = fields[i + 1]!;
      return {
        id,
        type: record.type as LiveEvent['type'],
        at: record.at ?? new Date().toISOString(),
        data: record.data ? (JSON.parse(record.data) as unknown) : null,
      };
    });
  }

  /**
   * Append to a run's live buffer and ring the doorbell.
   *
   * The worker publishes almost everything; the API only publishes state it
   * changes itself and the worker would never hear about, such as a run being
   * cancelled from the UI.
   */
  async publish(
    runId: string,
    events: Array<{ type: LiveEvent['type']; at: string; data: unknown }>,
  ): Promise<void> {
    if (events.length === 0) return;
    const pipeline = this.reader.pipeline();
    for (const event of events) {
      pipeline.xadd(
        liveStreamKey(runId),
        'MAXLEN',
        '~',
        '10000',
        '*',
        'type',
        event.type,
        'at',
        event.at,
        'data',
        JSON.stringify(event.data),
      );
    }
    pipeline.publish(liveChannel(runId), '1');
    await pipeline.exec();
  }

  /** The newest buffered id, so a fresh viewer starts at the tail. */
  async tailId(runId: string): Promise<string | null> {
    const entries = (await this.reader.xrevrange(
      liveStreamKey(runId),
      '+',
      '-',
      'COUNT',
      1,
    )) as Array<[string, string[]]>;
    return entries[0]?.[0] ?? null;
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber.disconnect();
    this.reader.disconnect();
  }
}
