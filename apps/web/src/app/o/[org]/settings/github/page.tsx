'use client';

import { use } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Github } from 'lucide-react';
import {
  getInstallUrl,
  getInstallation,
  unlinkInstallation,
  type ApiRequestError,
} from '@/lib/api';
import { useTranslate } from '@/lib/i18n';
import { AppShell } from '@/components/app-shell';
import { Badge, Button, Card, ConfirmButton, EmptyState, Skeleton } from '@/components/ui';

export default function OrgGithubSettingsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}): React.ReactElement {
  const { org } = use(params);
  const t = useTranslate();
  const queryClient = useQueryClient();

  const installation = useQuery({
    queryKey: ['github-installation', org],
    queryFn: () => getInstallation(org),
    retry: false,
  });

  const install = useMutation({
    mutationFn: () => getInstallUrl(org),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const unlink = useMutation({
    mutationFn: () => unlinkInstallation(org),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['github-installation', org] }),
  });

  // Without the App's env the whole group answers 503; saying so is more use
  // than a generic error, because nothing the admin does here can fix it.
  const error = (installation.error ?? install.error ?? unlink.error) as ApiRequestError | null;
  const notConfigured = error?.status === 503;

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Github className="h-5 w-5" aria-hidden />
            {t('github.title')}
          </h1>
          <p className="text-sm text-[var(--color-ink-muted)]">{org}</p>
        </header>

        {notConfigured ? (
          <EmptyState title={t('github.notConfigured')} body={error!.message} />
        ) : installation.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : installation.isError ? (
          <EmptyState title={t('common.error')} body={(installation.error as Error).message} />
        ) : !installation.data.installation ? (
          <EmptyState
            title={t('github.none.title')}
            body={t('github.none.body')}
            action={
              <Button onClick={() => install.mutate()} disabled={install.isPending}>
                {t('github.install')}
              </Button>
            }
          />
        ) : (
          <Card className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{installation.data.installation.accountLogin}</span>
              <Badge>{installation.data.installation.accountType}</Badge>
              {installation.data.installation.suspendedAt ? (
                <Badge tone="fail">{t('github.suspended')}</Badge>
              ) : null}
              <span className="ml-auto">
                <ConfirmButton
                  label={t('github.unlink')}
                  confirmLabel={t('common.confirm')}
                  disabled={unlink.isPending}
                  onConfirm={() => unlink.mutate()}
                />
              </span>
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-medium">
                {t('github.repositories')} ({installation.data.installation.repositories.length})
              </h2>
              <ul className="space-y-1 font-mono text-xs text-[var(--color-ink-muted)]">
                {installation.data.installation.repositories.map((repo) => (
                  <li key={repo}>{repo}</li>
                ))}
              </ul>
            </div>

            {error ? <p className="text-sm text-[var(--color-fail)]">{error.message}</p> : null}
          </Card>
        )}
      </div>
    </AppShell>
  );
}
