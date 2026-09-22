'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2, ChevronRight, Github } from 'lucide-react';
import { getMe } from '@/lib/api';
import { useTranslate } from '@/lib/i18n';
import { AppShell } from '@/components/app-shell';
import { Badge, Card, EmptyState, Skeleton } from '@/components/ui';

export default function OrgPage({
  params,
}: {
  params: Promise<{ org: string }>;
}): React.ReactElement {
  const { org } = use(params);
  const t = useTranslate();
  const me = useQuery({ queryKey: ['me'], queryFn: getMe, retry: false });

  const projects = (me.data?.projects ?? []).filter((p) => p.organizationSlug === org);

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t('projects.title')}</h1>
            <p className="text-sm text-[var(--color-ink-muted)]">{org}</p>
          </div>
          <Link
            href={`/o/${org}/settings/github`}
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-[var(--color-brand)] hover:underline"
          >
            <Github className="h-4 w-4" aria-hidden />
            {t('settings.github')}
          </Link>
        </div>

        {me.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 className="h-8 w-8" aria-hidden />}
            title={t('projects.empty.title')}
            body={t('projects.empty.body')}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/o/${org}/p/${project.slug}`}
                className="group block rounded-xl"
              >
                <Card className="h-full transition-colors group-hover:border-[var(--color-brand)]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <h2 className="font-medium">{project.name}</h2>
                      <p className="font-mono text-xs text-[var(--color-ink-muted)]">
                        {project.slug}
                      </p>
                    </div>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-[var(--color-ink-muted)]"
                      aria-hidden
                    />
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <span className="text-xs text-[var(--color-ink-muted)]">
                      {t('projects.role')}
                    </span>
                    <Badge tone="brand">{project.role}</Badge>
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
