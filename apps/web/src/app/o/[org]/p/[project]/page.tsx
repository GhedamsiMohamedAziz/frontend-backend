'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  GitBranch,
  Github,
  KeyRound,
  PlayCircle,
  Server,
  Settings,
  Users,
} from 'lucide-react';
import { getEnvironments, getMembers, getProject, getTokens } from '@/lib/api';
import { useTranslate } from '@/lib/i18n';
import { AppShell } from '@/components/app-shell';
import { Badge, Card, EmptyState, Skeleton } from '@/components/ui';

export default function ProjectPage({
  params,
}: {
  params: Promise<{ org: string; project: string }>;
}): React.ReactElement {
  const { org, project: slug } = use(params);
  const t = useTranslate();

  const project = useQuery({
    queryKey: ['project', org, slug],
    queryFn: () => getProject(org, slug),
    retry: false,
  });

  const environments = useQuery({
    queryKey: ['environments', org, slug],
    queryFn: () => getEnvironments(org, slug),
    enabled: project.isSuccess,
  });

  const members = useQuery({
    queryKey: ['members', org, slug],
    queryFn: () => getMembers(org, slug),
    enabled: project.isSuccess,
  });

  // The server decides; the UI only asks whether to render the panel at all.
  // Requesting tokens without the capability would just produce a 403 the user
  // never asked for.
  const canManageTokens = project.data?.capabilities.includes('token:manage') ?? false;
  const tokens = useQuery({
    queryKey: ['tokens', org, slug],
    queryFn: () => getTokens(org, slug),
    enabled: canManageTokens,
  });

  if (project.isPending) {
    return (
      <AppShell>
        <div className="space-y-4">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-40 w-full" />
        </div>
      </AppShell>
    );
  }

  if (project.isError || !project.data) {
    return (
      <AppShell>
        <EmptyState title={t('common.error')} body={(project.error as Error).message} />
      </AppShell>
    );
  }

  const detail = project.data;

  return (
    <AppShell>
      <div className="space-y-8">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{detail.name}</h1>
            <Badge tone="brand">{detail.role ?? 'org admin'}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-[var(--color-ink-muted)]">
            {detail.repoFullName ? (
              <span className="inline-flex items-center gap-1.5">
                <Github className="h-4 w-4" aria-hidden />
                {detail.repoFullName}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="h-4 w-4" aria-hidden />
              {detail.defaultBranch}
            </span>
          </div>
        </header>

        <Link href={`/o/${org}/p/${slug}/runs`} className="block">
          <Card className="flex items-center gap-3 transition-colors hover:border-[var(--color-brand)]">
            <PlayCircle className="h-5 w-5 text-[var(--color-brand)]" aria-hidden />
            <span className="font-medium">{t('runs.title')}</span>
            <span className="ml-auto text-sm text-[var(--color-ink-muted)]">
              {t('project.viewRuns')}
            </span>
          </Card>
        </Link>

        <Card className="space-y-3">
          <h2 className="flex items-center gap-2 font-medium">
            <Settings className="h-4 w-4 text-[var(--color-ink-muted)]" aria-hidden />
            {t('settings.title')}
          </h2>
          <ul className="flex flex-wrap gap-4 text-sm">
            {(
              [
                ['workflows', t('settings.workflows')],
                ['schedules', t('settings.schedules')],
                ['quality-gates', t('settings.gates')],
              ] as const
            ).map(([path, label]) => (
              <li key={path}>
                <Link
                  href={`/o/${org}/p/${slug}/settings/${path}`}
                  className="text-[var(--color-brand)] hover:underline"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3">
            <h2 className="flex items-center gap-2 font-medium">
              <Server className="h-4 w-4 text-[var(--color-ink-muted)]" aria-hidden />
              {t('project.environments')}
            </h2>
            {environments.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <ul className="space-y-2 text-sm">
                {environments.data?.map((environment) => (
                  <li key={environment.id} className="flex items-center justify-between gap-2">
                    <span>{environment.name}</span>
                    {environment.isProduction ? (
                      <Badge tone="fail">{t('common.production')}</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="flex items-center gap-2 font-medium">
              <Users className="h-4 w-4 text-[var(--color-ink-muted)]" aria-hidden />
              {t('project.members')}
            </h2>
            {members.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <ul className="space-y-2 text-sm">
                {members.data?.map((member) => (
                  <li key={member.userId} className="flex items-center justify-between gap-2">
                    <span>{member.name}</span>
                    <Badge>{member.role}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="flex items-center gap-2 font-medium">
              <KeyRound className="h-4 w-4 text-[var(--color-ink-muted)]" aria-hidden />
              {t('project.tokens')}
            </h2>
            {!canManageTokens ? (
              <p className="text-sm text-[var(--color-ink-muted)]">{t('project.tokens.hidden')}</p>
            ) : tokens.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <ul className="space-y-2 text-sm">
                {tokens.data?.map((token) => (
                  <li key={token.id} className="flex items-center justify-between gap-2">
                    <span>{token.name}</span>
                    <code className="text-xs text-[var(--color-ink-muted)]">
                      {token.tokenPrefix}…
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4 text-[var(--color-ink-muted)]" aria-hidden />
              {t('project.capabilities')}
            </h2>
            <ul className="flex flex-wrap gap-1.5">
              {detail.capabilities.map((capability) => (
                <li key={capability}>
                  <Badge tone="pass">{capability}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
