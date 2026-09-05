'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/format/cn';

/**
 * "Started" beside a leg whose kickoff has passed.
 *
 * Client-side because it depends on the current time, and the page is rendered
 * from cache: a server-rendered badge would be frozen at whatever it was when
 * the page was built. Nothing is shown until mount, so the server and client
 * markup agree.
 *
 * Only for legs with no result yet — once a leg is graded the tick or cross
 * says everything, and "started" beside a finished match reads as stale.
 */
export function LegStatus({
  kickoffIso,
  settled,
  className,
}: {
  kickoffIso: string;
  settled: boolean;
  className?: string;
}) {
  const t = useTranslations('predictions');
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (settled || now === null) return null;
  if (now < new Date(kickoffIso).getTime()) return null;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border border-emerald-primary/40 bg-emerald-primary/10 px-1.5 py-0.5 text-[0.6rem] font-semibold text-emerald-bright',
        className,
      )}
    >
      <span aria-hidden className="h-1 w-1 animate-pulse rounded-full bg-emerald-bright" />
      {t('started')}
    </span>
  );
}
