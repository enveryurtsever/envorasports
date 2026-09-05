import { defineRouting } from 'next-intl/routing';

/**
 * Turkish is the product's primary market, so it is the default and is served
 * without a prefix (`/matches`). English is prefixed (`/en/matches`) and stays
 * fully maintained — going global later is a config change, not a rewrite.
 *
 * Adding a third locale = add it here + drop a messages file next to it.
 */
export const routing = defineRouting({
  locales: ['tr', 'en'],
  defaultLocale: 'tr',
  localePrefix: 'as-needed',
  localeDetection: true,
});

export type AppLocale = (typeof routing.locales)[number];

export const LOCALE_LABELS: Record<AppLocale, string> = {
  tr: 'Türkçe',
  en: 'English',
};

/** Maps the URL locale to the `Locale` enum stored on `users.locale`. */
export const LOCALE_TO_DB: Record<AppLocale, 'EN' | 'TR'> = {
  en: 'EN',
  tr: 'TR',
};

export const DB_TO_LOCALE: Record<'EN' | 'TR', AppLocale> = {
  EN: 'en',
  TR: 'tr',
};

/**
 * BCP-47 tags used for Intl.NumberFormat / Intl.DateTimeFormat. Turkish uses a
 * comma decimal separator, which matters for odds like 2,45 vs 2.45.
 */
export const INTL_LOCALES: Record<AppLocale, string> = {
  en: 'en-GB',
  tr: 'tr-TR',
};
