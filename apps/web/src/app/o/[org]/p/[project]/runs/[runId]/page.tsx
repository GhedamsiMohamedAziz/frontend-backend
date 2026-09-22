'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Layers, Paperclip } from 'lucide-react';
import {
  attachmentUrl,
  getFailures,
  getResult,
  getResults,
  getProject,
  getRun,
  type FailureCluster,
} from '@/lib/api';
import type { LiveResult } from '@eyesonbug/shared';
import { useRunStream } from '@/lib/use-run-stream';
import { useTranslate } from '@/lib/i18n';
import { AppShell } from '@/components/app-shell';
import { LiveRun } from '@/components/live-run';
import { Badge, Card, EmptyState, Skeleton } from '@/components/ui';
import { StatusIcon, StatusPill, TotalsBar, formatDuration } from '@/components/status';

export default function RunReportPage({
  params,
}: {
  params: Promise<{ org: string; project: string; runId: string }>;
}): React.ReactElement {
  const { org, project, runId } = use(params);
  const t = useTranslate();
  const queryClient = useQueryClient();
  const [openResultId, setOpenResultId] = useState<string | null>(null);

  const run = useQuery({
    queryKey: ['run', org, project, runId],
    queryFn: () => getRun(org, project, runId),
    retry: false,
  });

  // Capabilities come from the project, so the UI offers Cancel only to
  // someone the API would actually let cancel.
  const project_ = useQuery({
    queryKey: ['project', org, project],
    queryFn: () => getProject(org, project),
    retry: false,
  });
  const capabilities = project_.data?.capabilities ?? [];

  const isLive = run.data?.status === 'running' || run.data?.status === 'queued';
  const stream = useRunStream(org, project, runId, Boolean(isLive));

  // The moment the run ends, swap the live feed for the full report. Everything
  // the live view had was a partial view of the same data.
  useEffect(() => {
    if (!stream.finished) return;
    void queryClient.invalidateQueries({ queryKey: ['run', org, project, runId] });
    void queryClient.invalidateQueries({ queryKey: ['failures', org, project, runId] });
    void queryClient.invalidateQueries({ queryKey: ['results', org, project, runId] });
  }, [stream.finished, queryClient, org, project, runId]);

  const failures = useQuery({
    queryKey: ['failures', org, project, runId],
    queryFn: () => getFailures(org, project, runId),
    enabled: run.isSuccess && !isLive,
  });

  const results = useQuery({
    queryKey: ['results', org, project, runId],
    queryFn: () => getResults(org, project, runId),
    // Also fetched while live, to seed the feed for a viewer who joined late.
    enabled: run.isSuccess,
    refetchInterval: isLive ? 15_000 : false,
  });

  if (run.isPending) {
    return (
      <AppShell>
        <div className="space-y-4">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppShell>
    );
  }

  if (run.isError || !run.data) {
    return (
      <AppShell>
        <EmptyState title={t('common.error')} body={(run.error as Error).message} />
      </AppShell>
    );
  }

  const detail = run.data;

  return (
    <AppShell>
      <div className="space-y-6">
        <Link
          href={`/o/${org}/p/${project}/runs`}
          className="inline-flex items-center gap-1 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('runs.title')}
        </Link>

        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">
              {t('run.title')} #{detail.number}
            </h1>
            <StatusPill status={detail.status} />
          </div>

          <p className="text-sm text-[var(--color-ink-muted)]">
            {detail.commitMessage ?? t('runs.noCommitMessage')}
          </p>

          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-muted)]">
            {detail.environment ? <Badge>{detail.environment}</Badge> : null}
            {detail.branch ? <Badge>{detail.branch}</Badge> : null}
            {detail.buildVersion ? <Badge>{detail.buildVersion}</Badge> : null}
            <span>{formatDuration(detail.durationMs)}</span>
          </div>
        </header>

        {isLive && stream.progress ? (
          <LiveRun
            org={org}
            project={project}
            runId={runId}
            progress={stream.progress}
            results={stream.results}
            connected={stream.connected}
            canCancel={capabilities.includes('run:cancel')}
            seeded={(results.data ?? []).map((result) => ({
              id: result.id,
              testCaseId: result.testCaseId,
              title: result.title,
              fullTitle: result.fullTitle,
              status: result.status as LiveResult['status'],
              durationMs: result.durationMs,
              configurationId: '',
              configurationLabel: [result.browser, result.locale].filter(Boolean).join(' · '),
              errorPreview: result.errorMessage?.split('\n')[0]?.slice(0, 200) ?? null,
              // Seeded rows carry no screenshot id; the streamed ones do, and
              // they replace these as soon as they arrive.
              screenshotAttachmentId: null,
            }))}
          />
        ) : (
          <>
            <Card className="space-y-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <Count label={t('status.passed')} value={detail.totals.passed} />
                <Count
                  label={t('status.failed')}
                  value={detail.totals.failed + detail.totals.broken}
                />
                <Count label={t('status.flaky')} value={detail.totals.flaky} />
                <Count label={t('status.skipped')} value={detail.totals.skipped} />
                <Count label={t('run.total')} value={detail.totals.total} />
              </div>
              <TotalsBar totals={detail.totals} />

              <div className="flex flex-wrap gap-2 pt-1">
                {detail.configurations.map((configuration) => (
                  <span
                    key={configuration.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs"
                  >
                    <StatusIcon status={configuration.status} className="h-3.5 w-3.5" />
                    {configuration.browser ?? '—'}
                    {configuration.locale ? ` · ${configuration.locale}` : ''}
                  </span>
                ))}
              </div>
            </Card>

            {/*
          Failures first, grouped by error signature. Twelve tests that failed
          for one reason are one thing to understand, not twelve.
        */}
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-lg font-medium">
                <Layers className="h-4 w-4 text-[var(--color-ink-muted)]" aria-hidden />
                {t('run.failureClusters')}
              </h2>

              {failures.isPending ? (
                <Skeleton className="h-32 w-full" />
              ) : !failures.data || failures.data.length === 0 ? (
                <EmptyState title={t('run.noFailures.title')} body={t('run.noFailures.body')} />
              ) : (
                failures.data.map((cluster) => (
                  <ClusterCard
                    key={cluster.signatureId}
                    cluster={cluster}
                    onOpen={setOpenResultId}
                    t={t}
                  />
                ))
              )}
            </section>

            <section className="space-y-3">
              <h2 className="text-lg font-medium">{t('run.allTests')}</h2>
              {results.isPending ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <Card className="p-0">
                  <ul className="divide-y divide-[var(--color-border)]">
                    {results.data?.map((result) => (
                      <li key={result.id}>
                        <button
                          type="button"
                          onClick={() => setOpenResultId(result.id)}
                          className="hover:bg-[var(--color-border)]/30 flex w-full items-center gap-3 px-4 py-2.5 text-left"
                        >
                          <StatusIcon status={result.status} />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {result.fullTitle}
                          </span>
                          {result.locale ? (
                            <span className="hidden text-xs text-[var(--color-ink-muted)] sm:inline">
                              {result.locale}
                            </span>
                          ) : null}
                          <span className="text-xs text-[var(--color-ink-muted)]">
                            {formatDuration(result.durationMs)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </section>
          </>
        )}
      </div>

      {openResultId ? (
        <ResultDrawer
          org={org}
          project={project}
          resultId={openResultId}
          onClose={() => setOpenResultId(null)}
        />
      ) : null}
    </AppShell>
  );
}

function Count({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <span>
      <span className="font-semibold">{value}</span>{' '}
      <span className="text-[var(--color-ink-muted)]">{label}</span>
    </span>
  );
}

function ClusterCard({
  cluster,
  onOpen,
  t,
}: {
  cluster: FailureCluster;
  onOpen: (id: string) => void;
  t: ReturnType<typeof useTranslate>;
}): React.ReactElement {
  // The signature is built from the whole normalized message, but only its
  // first line is worth putting in a heading.
  const headline = cluster.normalizedMessage.split(/(?<=\.)\s|\s{2,}/)[0] ?? cluster.errorType;

  return (
    <Card className="space-y-3 border-l-2 border-l-[var(--color-fail)]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-[var(--color-fail)]">{cluster.errorType}</p>
          <p className="mt-1 line-clamp-2 text-sm">{headline}</p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs">
          {cluster.count} {t(cluster.count === 1 ? 'cluster.failure' : 'cluster.failures')} ·{' '}
          {cluster.affectedTests}{' '}
          {t(cluster.affectedTests === 1 ? 'cluster.test' : 'cluster.tests')}
        </span>
      </div>

      <ul className="space-y-1">
        {cluster.results.map((result) => (
          <li key={result.resultId}>
            <button
              type="button"
              onClick={() => onOpen(result.resultId)}
              className="hover:bg-[var(--color-border)]/40 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{result.fullTitle}</span>
              {result.locale ? (
                <span className="text-xs text-[var(--color-ink-muted)]">{result.locale}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ResultDrawer({
  org,
  project,
  resultId,
  onClose,
}: {
  org: string;
  project: string;
  resultId: string;
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const result = useQuery({
    queryKey: ['result', org, project, resultId],
    queryFn: () => getResult(org, project, resultId),
  });

  const screenshot = result.data?.attachments.find((a) => a.kind === 'screenshot');

  return (
    <div
      className="fixed inset-0 z-20 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] p-6"
        onClick={(event) => event.stopPropagation()}
      >
        {result.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : result.data ? (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-medium">{result.data.title}</h3>
                <p className="font-mono text-xs text-[var(--color-ink-muted)]">
                  {result.data.filePath}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="hover:bg-[var(--color-border)]/40 rounded-md px-2 py-1 text-sm"
              >
                {t('common.close')}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={result.data.status} />
              {result.data.browser ? <Badge>{result.data.browser}</Badge> : null}
              {result.data.locale ? <Badge>{result.data.locale}</Badge> : null}
              <span className="text-xs text-[var(--color-ink-muted)]">
                {formatDuration(result.data.durationMs)}
              </span>
              {result.data.retryIndex > 0 ? (
                <Badge tone="fail">
                  {t('result.retry')} {result.data.retryIndex}
                </Badge>
              ) : null}
            </div>

            {/*
              The history strip answers the first question anyone asks about a
              red test: is this new, or has it been failing for a week?
            */}
            <div>
              <h4 className="mb-2 text-sm font-medium">{t('result.history')}</h4>
              <div className="flex flex-wrap gap-1">
                {[...result.data.history].reverse().map((entry) => (
                  <span
                    key={entry.id}
                    title={`#${entry.runNumber} — ${entry.status}`}
                    className="h-5 w-2.5 rounded-sm"
                    style={{
                      background:
                        entry.status === 'passed'
                          ? 'var(--color-pass)'
                          : entry.status === 'flaky'
                            ? 'var(--color-flaky)'
                            : entry.status === 'skipped'
                              ? 'var(--color-skip)'
                              : 'var(--color-fail)',
                    }}
                  />
                ))}
              </div>
            </div>

            {result.data.errorMessage ? (
              <div>
                <h4 className="mb-2 text-sm font-medium">{t('result.error')}</h4>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-xs">
                  {result.data.errorMessage}
                </pre>
              </div>
            ) : null}

            {screenshot ? (
              <div>
                <h4 className="mb-2 text-sm font-medium">{t('result.screenshot')}</h4>
                {/*
                  A plain <img>, not next/image: the src is an API route that
                  authorizes and then 302s to a short-lived signed URL, which
                  the image optimizer can neither cache nor re-sign.
                */}
                <img
                  src={attachmentUrl(org, project, screenshot.id)}
                  alt={t('result.screenshot')}
                  className="w-full rounded-lg border border-[var(--color-border)]"
                />
              </div>
            ) : null}

            {result.data.attachments.length > 0 ? (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Paperclip className="h-3.5 w-3.5" aria-hidden />
                  {t('result.artifacts')}
                </h4>
                <ul className="space-y-1 text-sm">
                  {result.data.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        href={attachmentUrl(org, project, attachment.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--color-brand)] hover:underline"
                      >
                        {attachment.kind} ({Math.round(attachment.sizeBytes / 1024)} kB)
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
