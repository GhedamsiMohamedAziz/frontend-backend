'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Eye, Github } from 'lucide-react';
import { devLogin, startGithubLogin } from '@/lib/api';
import type { ApiRequestError } from '@/lib/api';
import { useTranslate } from '@/lib/i18n';
import { Button, Card } from '@/components/ui';

const SEEDED_ACCOUNTS = [
  { email: 'demo@eyesonbug.dev', label: 'Owner — admin everywhere' },
  { email: 'dev@eyesonbug.dev', label: 'Maintainer — can configure runs' },
  { email: 'qa@eyesonbug.dev', label: 'QA — can triage and rerun' },
  { email: 'viewer@eyesonbug.dev', label: 'Viewer — read only' },
  { email: 'outsider@northwind.dev', label: 'Another tenant — sees none of Acme' },
];

export default function LoginPage(): React.ReactElement {
  const t = useTranslate();
  const router = useRouter();
  const [email, setEmail] = useState(SEEDED_ACCOUNTS[0]!.email);

  const signIn = useMutation({
    mutationFn: devLogin,
    onSuccess: () => router.push('/'),
  });

  const github = useMutation({
    mutationFn: startGithubLogin,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const error = (signIn.error ?? github.error) as ApiRequestError | null;

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <Eye className="h-8 w-8 text-[var(--color-brand)]" aria-hidden />
          <h1 className="text-xl font-semibold">{t('app.name')}</h1>
          <p className="text-sm text-[var(--color-ink-muted)]">{t('app.tagline')}</p>
        </div>

        <Card className="space-y-5">
          <Button className="w-full" onClick={() => github.mutate()} disabled={github.isPending}>
            <Github className="h-4 w-4" aria-hidden />
            {t('login.github')}
          </Button>

          <div className="flex items-center gap-3 text-xs text-[var(--color-ink-muted)]">
            <span className="h-px flex-1 bg-[var(--color-border)]" />
            <span>{t('login.devTitle')}</span>
            <span className="h-px flex-1 bg-[var(--color-border)]" />
          </div>

          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              signIn.mutate(email);
            }}
          >
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Account</span>
              <select
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              >
                {SEEDED_ACCOUNTS.map((account) => (
                  <option key={account.email} value={account.email}>
                    {account.email} — {account.label}
                  </option>
                ))}
              </select>
            </label>

            <Button variant="ghost" className="w-full" type="submit" disabled={signIn.isPending}>
              {t('login.signIn')}
            </Button>
          </form>

          <p className="text-xs text-[var(--color-ink-muted)]">{t('login.devHint')}</p>

          {error ? (
            <p role="alert" className="text-sm text-[var(--color-fail)]">
              {t('login.failed')}: {error.message}
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
