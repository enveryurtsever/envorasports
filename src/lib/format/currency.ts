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

/**
 * Default reference stake, and the smallest coupon that can actually be played:
 * 50 TL is the floor on a Turkish slip. Quoting a return against a stake nobody
 * can place makes the figure a hypothetical. The live value comes from the
 * `display.referenceStake` setting so it can change without a deploy.
 */
export const DEFAULT_REFERENCE_STAKE = 50;

/** No slip may cost less than this, systems included. */
export const MIN_COUPON_STAKE = 50;

export function currencyFor(locale: string): string {
  return LOCALE_CURRENCY[locale as AppLocale] ?? 'EUR';
}

export interface ReferenceStake {
  amount: number;
  currency: string;
}

/** Synchronous fallback for contexts that cannot await a setting. */
export function referenceStakeFor(locale: string): ReferenceStake {
  return { amount: DEFAULT_REFERENCE_STAKE, currency: currencyFor(locale) };
}

import { getAppSetting } from '@/lib/config/settings-service';

/** The operator-configured reference stake for this locale's currency. */
export async function getReferenceStake(locale: string): Promise<ReferenceStake> {
  const amount = await getAppSetting<number>('display.referenceStake', DEFAULT_REFERENCE_STAKE);
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_REFERENCE_STAKE,
    currency: currencyFor(locale),
  };
}
