'use client';

import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import type { UiLocale } from '@eyesonbug/shared';
import { getMe } from '@/lib/api';
import { LocaleContext } from '@/lib/i18n';

/**
 * The interface language follows the signed-in user's stored preference.
 *
 * It lives inside the query provider rather than in the server layout because
 * the preference belongs to the session, and the root layout is rendered before
 * we know who is asking. While `me` is in flight the last known choice is read
 * from localStorage, so switching language does not flash English on the next
 * navigation.
 */
function LocaleProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [cached, setCached] = useState<UiLocale>('en');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('eob:locale');
      if (stored === 'en' || stored === 'fr') setCached(stored);
    } catch {
      // Private browsing or blocked storage: English is a fine default.
    }
  }, []);

  const me = useQuery({ queryKey: ['me'], queryFn: getMe, retry: false });
  const locale: UiLocale = me.data?.user.locale ?? cached;

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem('eob:locale', locale);
    } catch {
      // Non-fatal: the preference still lives on the server.
    }
  }, [locale]);

  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function Providers({ children }: { children: React.ReactNode }): React.ReactElement {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Run data changes constantly; stale-while-revalidate keeps the UI
            // responsive without showing numbers that are minutes old.
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) => {
              // Never retry an auth or permission failure: the answer will not
              // change, and retrying just delays the redirect to sign-in.
              const status = (error as { status?: number }).status;
              if (status === 401 || status === 403 || status === 404) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <LocaleProvider>{children}</LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
