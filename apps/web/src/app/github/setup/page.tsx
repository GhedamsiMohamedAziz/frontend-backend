'use client';

import { Suspense, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Github } from 'lucide-react';
import { linkInstallation, type ApiRequestError } from '@/lib/api';
import { useTranslate } from '@/lib/i18n';
import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui';

/**
 * Where GitHub sends an admin after installing the App.
 *
 * It arrives as `?installation_id=<n>&state=<orgSlug>` — `state` is the org we
 * put in the install URL, so the redirect knows which tenant to link without
 * asking the user to pick one again.
 */
export default function GithubSetupPage(): React.ReactElement {
  return (
    <Suspense fallback={<Skeleton className="h-32 w-full" />}>
      <GithubSetup />
    </Suspense>
  );
}

function GithubSetup(): React.ReactElement {
  const t = useTranslate();
  const params = useSearchParams();
  const org = params.get('state');
  const installationId = Number(params.get('installation_id'));

  const link = useMutation({
    mutationFn: () => linkInstallation(org!, installationId),
  });

  // React 19 mounts effects twice in development; the mutation is not
  // idempotent enough to enjoy that, so it fires exactly once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !org || !Number.isInteger(installationId) || installationId <= 0) return;
    started.current = true;
    link.mutate();
  }, [link, org, installationId]);

  const error = link.error as ApiRequestError | null;

  return (
    <AppShell>
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Github className="h-5 w-5" aria-hidden />
          {t('github.setup.title')}
        </h1>

        {!org || !Number.isInteger(installationId) || installationId <= 0 ? (
          <EmptyState title={t('common.error')} body={t('github.setup.missing')} />
        ) : link.isSuccess ? (
          <Card className="space-y-3">
            <p className="font-medium">{t('github.setup.success')}</p>
            <p className="text-sm text-[var(--color-ink-muted)]">
              {link.data.accountLogin} · {link.data.repositories.length}{' '}
              {t('github.setup.repositories')}
            </p>
            <Link href={`/o/${org}/settings/github`} className="inline-block">
              <Button>{t('github.setup.goToSettings')}</Button>
            </Link>
          </Card>
        ) : error ? (
          // A 403 here says exactly which rule was not met, so it is shown as
          // written rather than flattened into "something went wrong".
          <EmptyState title={t('common.error')} body={error.message} />
        ) : (
          <Card>
            <p className="text-sm text-[var(--color-ink-muted)]">{t('github.setup.pending')}</p>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
