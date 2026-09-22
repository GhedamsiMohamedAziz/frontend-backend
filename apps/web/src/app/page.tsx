'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getMe } from '@/lib/api';
import { Skeleton } from '@/components/ui';

/**
 * The entry point routes you to where your work is: your first organization,
 * or sign-in if there is no session. Landing on a generic home page and then
 * hunting for your project would spend one of the three clicks the spec allows.
 */
export default function HomePage(): React.ReactElement {
  const router = useRouter();
  const me = useQuery({ queryKey: ['me'], queryFn: getMe, retry: false });

  useEffect(() => {
    if (me.isError) {
      router.replace('/login');
      return;
    }
    const org = me.data?.organizations[0];
    if (org) router.replace(`/o/${org.slug}`);
  }, [me.data, me.isError, router]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-8">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
