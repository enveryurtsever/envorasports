import type { AppLocale } from '@/i18n/routing';

/**
 * Display currency per locale.
 *
 * These are not converted amounts. The "max return" figure is a *reference*
 * stake multiplied by the coupon's odds, so a Turkish reader is shown what 100
 * TL would return and an English reader what 100 EUR would — no exchange rate
 * is involved, and none is invented.
 *
 * Money that is genuinely stored with a currency (a plan price, a system
 * coupon's stake) is always displayed in the currency it was stored in.
 */
export const LOCALE_CURRENCY: Record<AppLocale, string> = {
  en: 'EUR',
  tr: 'TRY',
};

/** Reference stake used for "what would this return" figures. */
export const REFERENCE_STAKE_BY_CURRENCY: Record<string, number> = {
  EUR: 100,
  TRY: 100,
};

export function currencyFor(locale: string): string {
  return LOCALE_CURRENCY[locale as AppLocale] ?? 'EUR';
}

export function referenceStakeFor(locale: string): { amount: number; currency: string } {
  const currency = currencyFor(locale);
  return { amount: REFERENCE_STAKE_BY_CURRENCY[currency] ?? 100, currency };
}
