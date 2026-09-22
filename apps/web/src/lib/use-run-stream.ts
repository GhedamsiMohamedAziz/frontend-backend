'use client';

import { useEffect, useRef, useState } from 'react';
import type { LiveResult, RunProgress } from '@eyesonbug/shared';

export interface RunStreamState {
  progress: RunProgress | null;
  /** Newest first, so the most recent failure is always at the top. */
  results: LiveResult[];
  connected: boolean;
  finished: boolean;
}

/** Keeps the feed bounded; the full list lives in the run report. */
const MAX_RESULTS = 200;

/**
 * Subscribe to a run's live feed.
 *
 * `EventSource` rather than a hand-rolled fetch loop: it reconnects on its own
 * and replays `Last-Event-ID` automatically, which is exactly the resume the
 * server implements. It also sends the session cookie, because the stream is
 * served from the same origin through the Next rewrite.
 */
export function useRunStream(
  org: string,
  project: string,
  runId: string,
  enabled: boolean,
): RunStreamState {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [results, setResults] = useState<LiveResult[]>([]);
  const [connected, setConnected] = useState(false);
  const [finished, setFinished] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;

    const source = new EventSource(`/api/v1/o/${org}/p/${project}/runs/${runId}/stream`, {
      withCredentials: true,
    });

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));

    source.addEventListener('run.progress', (event) => {
      setConnected(true);
      setProgress(JSON.parse((event as MessageEvent<string>).data) as RunProgress);
    });

    source.addEventListener('result.finished', (event) => {
      const result = JSON.parse((event as MessageEvent<string>).data) as LiveResult;
      // A reconnect replays from the last id the browser applied, but a missed
      // doorbell can re-deliver the boundary event. Dedupe by result id.
      if (seen.current.has(result.id)) return;
      seen.current.add(result.id);
      setResults((current) => [result, ...current].slice(0, MAX_RESULTS));
    });

    source.addEventListener('run.finished', (event) => {
      setProgress(JSON.parse((event as MessageEvent<string>).data) as RunProgress);
      setFinished(true);
      // The server closes after this; closing here stops EventSource from
      // reconnecting to a stream that will never produce anything again.
      source.close();
      setConnected(false);
    });

    return () => source.close();
  }, [org, project, runId, enabled]);

  return { progress, results, connected, finished };
}

export function formatEta(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
