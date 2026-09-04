'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { LOCALE_LABELS, routing, type AppLocale } from '@/i18n/routing';
import { cn } from '@/lib/format/cn';

/**
 * Swaps locale while staying on the same page.
 *
 * `usePathname` from our navigation helpers returns the path without the locale
 * prefix, so replacing it is a straight swap — no string surgery on the URL.
 */
export function LocaleSwitcher() {
  const t = useTranslations('locale');
  const locale = useLocale() as AppLocale;
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5">
      <span className="sr-only">{t('label')}</span>
      {routing.locales.map((option) => {
        const active = option === locale;
        return (
          <button
            key={option}
            type="button"
            lang={option}
            aria-current={active ? 'true' : undefined}
            aria-label={t('switchTo', { language: LOCALE_LABELS[option] })}
            disabled={isPending || active}
            onClick={() => {
              startTransition(() => {
                router.replace(pathname, { locale: option });
              });
            }}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold uppercase transition-colors',
              active
                ? 'bg-emerald-primary text-white'
                : 'text-muted hover:text-paper disabled:opacity-50',
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
