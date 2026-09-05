'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/format/cn';

/**
 * Time until the coupon's first kickoff.
 *
 * Rendered on the client because it has to tick. The server sends the kickoff
 * instant, not a pre-computed string — a cached page would otherwise show a
 * countdown frozen at whatever it was when the page was generated.
 */
export function KickoffCountdown({
  firstKickoffIso,
  lastKickoffIso,
  settled = false,
  className,
}: {
  firstKickoffIso: string;
  lastKickoffIso: string;
  settled?: boolean;
  className?: string;
}) {
  const t = useTranslations('predictions');
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Set on mount rather than during render: the server and the client would
    // otherwise disagree about "now" and React would flag a hydration mismatch.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (now === null) return null;

  const first = new Date(firstKickoffIso).getTime();
  const last = new Date(lastKickoffIso).getTime();

  if (settled) return null;

  // Every match kicked off but nothing is graded yet.
  if (now >= last) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-emerald-bright', className)}>
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-bright" />
        {t('inPlay')}
      </span>
    );
  }

  if (now >= first) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-emerald-bright', className)}>
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-bright" />
        {t('started')}
      </span>
    );
  }

  const minutesLeft = Math.max(0, Math.ceil((first - now) / 60_000));
  const days = Math.floor(minutesLeft / (60 * 24));
  const hours = Math.floor((minutesLeft % (60 * 24)) / 60);
  const minutes = minutesLeft % 60;

  const label =
    days > 0
      ? t('startsInDays', { days, hours })
      : hours > 0
        ? t('startsInHours', { hours, minutes })
        : t('startsInMinutes', { minutes });

  // Under an hour is worth noticing.
  const imminent = minutesLeft <= 60;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5',
        imminent ? 'text-gold-light' : 'text-muted',
        className,
      )}
    >
      <span aria-hidden>⏱</span>
      {label}
    </span>
  );
}
