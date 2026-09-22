'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, LogOut, Moon, Sun, Languages } from 'lucide-react';
import type { UiLocale } from '@eyesonbug/shared';
import { apiFetch, getMe, logout } from '@/lib/api';
import { useLocale, useTranslate } from '@/lib/i18n';
import { Button, Skeleton } from './ui';

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const t = useTranslate();
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();

  const me = useQuery({ queryKey: ['me'], queryFn: getMe, retry: false });

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      router.push('/login');
    },
  });

  const setLocale = useMutation({
    mutationFn: (next: UiLocale) =>
      apiFetch('/v1/me', { method: 'PATCH', body: JSON.stringify({ locale: next }) }),
    // `me` is what drives the interface language, so refetching it is what
    // actually re-renders the UI in the new language.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <div className="min-h-dvh">
      <header className="bg-[var(--color-surface)]/85 sticky top-0 z-10 border-b border-[var(--color-border)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Eye className="h-5 w-5 text-[var(--color-brand)]" aria-hidden />
            <span>{t('app.name')}</span>
          </Link>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLocale.mutate(locale === 'en' ? 'fr' : 'en')}
              className="hover:bg-[var(--color-border)]/40 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm"
              aria-label={t('nav.language')}
            >
              <Languages className="h-4 w-4" aria-hidden />
              <span className="uppercase">{locale}</span>
            </button>

            <button
              type="button"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className="hover:bg-[var(--color-border)]/40 rounded-lg p-2"
              aria-label={t('nav.theme')}
            >
              {/* Rendered only after mount would flash; next-themes handles the
                  class on <html>, so both icons are safe to render immediately. */}
              <Sun className="h-4 w-4 dark:hidden" aria-hidden />
              <Moon className="hidden h-4 w-4 dark:block" aria-hidden />
            </button>

            {me.isPending ? (
              <Skeleton className="h-8 w-28" />
            ) : me.data ? (
              <div className="flex items-center gap-2 pl-2">
                <span className="hidden text-sm text-[var(--color-ink-muted)] sm:inline">
                  {me.data.user.name}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => signOut.mutate()}
                  disabled={signOut.isPending}
                  aria-label={t('nav.signOut')}
                >
                  <LogOut className="h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">{t('nav.signOut')}</span>
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
