import { defineRouting } from 'next-intl/routing';

/**
 * English is the source language and the product default, so it is served
 * without a prefix (`/matches`). Turkish is prefixed (`/tr/matches`).
 *
 * Adding a third locale = add it here + drop a messages file next to it.
 */
export const routing = defineRouting({
  locales: ['en', 'tr'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  localeDetection: true,
});

export type AppLocale = (typeof routing.locales)[number];

export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  tr: 'Türkçe',
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
