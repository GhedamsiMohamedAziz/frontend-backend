'use client';

import { Check, CircleSlash, Repeat, TriangleAlert, X, Loader } from 'lucide-react';
import { cn } from './ui';

/**
 * Status is never colour alone.
 *
 * Roughly one man in twelve cannot separate the red and green that carry the
 * most important distinction on every one of these screens, so each status
 * pairs its colour with a distinct glyph. The colours also come from CSS
 * variables that are redefined for dark mode, so contrast holds in both themes.
 */
const STATUS = {
  passed: { icon: Check, color: 'var(--color-pass)', label: 'Passed' },
  failed: { icon: X, color: 'var(--color-fail)', label: 'Failed' },
  broken: { icon: TriangleAlert, color: 'var(--color-fail)', label: 'Broken' },
  flaky: { icon: Repeat, color: 'var(--color-flaky)', label: 'Flaky' },
  skipped: { icon: CircleSlash, color: 'var(--color-skip)', label: 'Skipped' },
  running: { icon: Loader, color: 'var(--color-running)', label: 'Running' },
  queued: { icon: Loader, color: 'var(--color-skip)', label: 'Queued' },
  cancelled: { icon: CircleSlash, color: 'var(--color-skip)', label: 'Cancelled' },
  errored: { icon: TriangleAlert, color: 'var(--color-fail)', label: 'Errored' },
} as const;

export type StatusKey = keyof typeof STATUS;

const resolve = (status: string) => STATUS[status as StatusKey] ?? STATUS.queued;

export function StatusIcon({
  status,
  className,
}: {
  status: string;
  className?: string;
}): React.ReactElement {
  const { icon: Icon, color, label } = resolve(status);
  return (
    <Icon
      className={cn('h-4 w-4 shrink-0', className)}
      style={{ color }}
      aria-label={label}
      role="img"
    />
  );
}

export function StatusPill({ status }: { status: string }): React.ReactElement {
  const { icon: Icon, color, label } = resolve(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ color, borderColor: color }}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

/**
 * A single bar showing a run's composition. Proportional rather than a set of
 * counts, so "mostly green with a sliver of red" reads at a glance.
 */
export function TotalsBar({
  totals,
}: {
  totals: { passed: number; failed: number; broken: number; flaky: number; skipped: number };
}): React.ReactElement {
  const segments = [
    { key: 'passed', value: totals.passed, color: 'var(--color-pass)' },
    { key: 'failed', value: totals.failed + totals.broken, color: 'var(--color-fail)' },
    { key: 'flaky', value: totals.flaky, color: 'var(--color-flaky)' },
    { key: 'skipped', value: totals.skipped, color: 'var(--color-skip)' },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;

  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
      role="img"
      aria-label={`${totals.passed} passed, ${totals.failed + totals.broken} failed, ${totals.flaky} flaky, ${totals.skipped} skipped`}
    >
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <div
            key={segment.key}
            style={{ width: `${(segment.value / total) * 100}%`, background: segment.color }}
          />
        ))}
    </div>
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
