import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';
import { INTL_LOCALES } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
    // Kickoff times are stored in UTC; render them in the user's zone.
    timeZone: 'Europe/Istanbul',
    now: new Date(),
    formats: {
      dateTime: {
        kickoff: { hour: '2-digit', minute: '2-digit' },
        short: { day: '2-digit', month: 'short' },
        full: { dateStyle: 'medium', timeStyle: 'short' },
      },
      number: {
        odds: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
        percent: { style: 'percent', maximumFractionDigits: 1 },
        signedPercent: { style: 'percent', maximumFractionDigits: 1, signDisplay: 'always' },
      },
    },
    onError(error) {
      // A missing translation must never blank out a page. Log and fall back.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[i18n:${locale}]`, error.message);
      }
    },
    getMessageFallback({ key, namespace }) {
      return namespace ? `${namespace}.${key}` : key;
    },
  };
});

export { INTL_LOCALES };
