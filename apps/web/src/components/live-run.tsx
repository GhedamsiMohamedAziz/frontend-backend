'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Ban, WifiOff } from 'lucide-react';
import type { LiveResult, RunProgress } from '@eyesonbug/shared';
import { attachmentUrl, cancelRun } from '@/lib/api';
import { formatEta } from '@/lib/use-run-stream';
import { useTranslate } from '@/lib/i18n';
import { Badge, Button, Card } from './ui';
import { StatusIcon, TotalsBar, formatDuration } from './status';

/**
 * The live view of a run in flight.
 *
 * Optimised for the question someone actually has while a suite is running:
 * "is it going to pass, and if not, what broke?" So failures get their own rail
 * at the top with an error preview and a screenshot, ahead of the full list —
 * scrolling a thousand green rows to find the red one is not a live view.
 */
export function LiveRun({
  org,
  project,
  runId,
  progress,
  results,
  connected,
  canCancel,
  seeded,
}: {
  org: string;
  project: string;
  runId: string;
  progress: RunProgress;
  results: LiveResult[];
  connected: boolean;
  canCancel: boolean;
  /**
   * Results that finished before this browser connected.
   *
   * The stream starts at its tail, so a viewer arriving mid-run would otherwise
   * see "waiting for the first results" next to a counter reading 23.
   */
  seeded: LiveResult[];
}): React.ReactElement {
  const t = useTranslate();
  const queryClient = useQueryClient();

  const cancel = useMutation({
    mutationFn: () => cancelRun(org, project, runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['run', org, project, runId] }),
  });

  // Streamed results win over seeded ones: same result, fresher payload.
  const streamedIds = new Set(results.map((result) => result.id));
  const merged = [...results, ...seeded.filter((result) => !streamedIds.has(result.id))];

  const done = progress.totals.total;
  const expected = progress.expectedTotal;
  const percent = expected && expected > 0 ? Math.min(100, (done / expected) * 100) : null;
  const eta = formatEta(progress.etaMs);
  const failures = merged.filter((r) => r.status === 'failed' || r.status === 'broken');

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-running)]">
            <Activity className="h-4 w-4 animate-pulse" aria-hidden />
            {t('live.running')}
          </span>

          {!connected ? (
            // Say so rather than quietly showing numbers that stopped updating.
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
              <WifiOff className="h-3.5 w-3.5" aria-hidden />
              {t('live.reconnecting')}
            </span>
          ) : null}

          <span className="ml-auto text-sm text-[var(--color-ink-muted)]">
            {expected ? (
              <>
                {done} / ~{expected}
              </>
            ) : (
              <>{done}</>
            )}
            {eta ? ` · ${t('live.eta')} ${eta}` : ''}
          </span>

          {canCancel ? (
            <Button
              variant="ghost"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              title={t('live.cancelHint')}
            >
              <Ban className="h-4 w-4" aria-hidden />
              {t('live.cancel')}
            </Button>
          ) : null}
        </div>

        {/* Whether the GitHub job stopped too is the part a cancel cannot
            always deliver, so it is reported rather than assumed. */}
        {cancel.data ? (
          <p className="text-sm text-[var(--color-ink-muted)]">
            {t(cancel.data.githubCancelled ? 'live.cancelled.github' : 'live.cancelled.local')}
          </p>
        ) : null}

        {percent !== null ? (
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
            role="progressbar"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-[var(--color-running)] transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : (
          <TotalsBar totals={progress.totals} />
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <Stat label={t('status.passed')} value={progress.totals.passed} />
          <Stat
            label={t('status.failed')}
            value={progress.totals.failed + progress.totals.broken}
          />
          <Stat label={t('status.flaky')} value={progress.totals.flaky} />
          <Stat label={t('status.skipped')} value={progress.totals.skipped} />
        </div>
      </Card>

      {/* Per-configuration lanes: which cell of the matrix is lagging, and
          which one is producing the failures. */}
      <Card className="space-y-3">
        <h2 className="text-sm font-medium">{t('live.lanes')}</h2>
        <ul className="space-y-2">
          {progress.configurations.map((configuration) => {
            const share =
              expected && expected > 0
                ? Math.min(
                    100,
                    (configuration.done / (expected / progress.configurations.length)) * 100,
                  )
                : 0;
            return (
              <li key={configuration.id} className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <StatusIcon status={configuration.status} className="h-3.5 w-3.5" />
                  <span className="flex-1 truncate">{configuration.label}</span>
                  {configuration.failed > 0 ? (
                    <span className="text-[var(--color-fail)]">{configuration.failed}</span>
                  ) : null}
                  <span className="text-[var(--color-ink-muted)]">{configuration.done}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
                  <div
                    className="h-full transition-[width] duration-500"
                    style={{
                      width: `${share}%`,
                      background:
                        configuration.failed > 0 ? 'var(--color-fail)' : 'var(--color-running)',
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {failures.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium text-[var(--color-fail)]">
            {t('live.failuresSoFar')}
          </h2>
          {failures.map((result) => (
            <Card
              key={result.id}
              className="flex gap-3 border-l-2 border-l-[var(--color-fail)] p-3"
            >
              {result.screenshotAttachmentId ? (
                /*
                  A thumbnail beside the failure is usually enough to tell a
                  product bug from a broken selector without opening anything.
                  A plain <img>, not next/image: the src is an API route that
                  authorizes and then redirects to a short-lived signed URL.
                  Decorative here — the failure is described in the text beside
                  it — so the alt text is deliberately empty.
                */
                <img
                  src={attachmentUrl(org, project, result.screenshotAttachmentId)}
                  alt=""
                  className="h-16 w-28 shrink-0 rounded border border-[var(--color-border)] object-cover"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{result.fullTitle}</p>
                <p className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
                  <Badge>{result.configurationLabel}</Badge>
                  {formatDuration(result.durationMs)}
                </p>
                {result.errorPreview ? (
                  <p className="mt-1 truncate font-mono text-xs text-[var(--color-fail)]">
                    {result.errorPreview}
                  </p>
                ) : null}
              </div>
            </Card>
          ))}
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">{t('live.recent')}</h2>
        <Card className="p-0">
          <ul className="divide-y divide-[var(--color-border)]">
            {merged.slice(0, 40).map((result) => (
              <li key={result.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <StatusIcon status={result.status} />
                <span className="min-w-0 flex-1 truncate">{result.fullTitle}</span>
                <span className="hidden text-xs text-[var(--color-ink-muted)] sm:inline">
                  {result.configurationLabel}
                </span>
                <span className="text-xs text-[var(--color-ink-muted)]">
                  {formatDuration(result.durationMs)}
                </span>
              </li>
            ))}
            {merged.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-[var(--color-ink-muted)]">
                {t('live.waiting')}
              </li>
            ) : null}
          </ul>
        </Card>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <span>
      <span className="font-semibold tabular-nums">{value}</span>{' '}
      <span className="text-[var(--color-ink-muted)]">{label}</span>
    </span>
  );
}
