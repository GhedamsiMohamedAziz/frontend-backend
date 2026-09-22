'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, PlayCircle } from 'lucide-react';
import { getRuns } from '@/lib/api';
import { useTranslate } from '@/lib/i18n';
import { AppShell } from '@/components/app-shell';
import { Card, EmptyState, Skeleton } from '@/components/ui';
import { StatusIcon, TotalsBar, formatDuration } from '@/components/status';

export default function RunsPage({
  params,
}: {
  params: Promise<{ org: string; project: string }>;
}): React.ReactElement {
  const { org, project } = use(params);
  const t = useTranslate();

  const runs = useQuery({
    queryKey: ['runs', org, project],
    queryFn: () => getRuns(org, project, 'limit=50'),
  });

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{t('runs.title')}</h1>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {org}/{project}
          </p>
        </div>

        {runs.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !runs.data || runs.data.items.length === 0 ? (
          <EmptyState
            icon={<PlayCircle className="h-8 w-8" aria-hidden />}
            title={t('runs.empty.title')}
            body={t('runs.empty.body')}
          />
        ) : (
          <div className="space-y-2">
            {runs.data.items.map((run) => (
              <Link key={run.id} href={`/o/${org}/p/${project}/runs/${run.id}`} className="block">
                <Card className="transition-colors hover:border-[var(--color-brand)]">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <StatusIcon status={run.status} />
                    <span className="font-medium">#{run.number}</span>

                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-ink-muted)]">
                      {run.commitMessage ?? t('runs.noCommitMessage')}
                    </span>

                    {run.branch ? (
                      <span className="inline-flex items-center gap-1 text-xs text-[var(--color-ink-muted)]">
                        <GitBranch className="h-3.5 w-3.5" aria-hidden />
                        {run.branch}
                      </span>
                    ) : null}

                    <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                      {run.totals.passed}/{run.totals.total}
                    </span>
                    <span className="text-xs text-[var(--color-ink-muted)]">
                      {formatDuration(run.durationMs)}
                    </span>
                  </div>

                  <div className="mt-3">
                    <TotalsBar totals={run.totals} />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
