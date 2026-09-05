import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';
import { INTL_LOCALES } from './routing';
import { APP_FORMATS, TIME_ZONE } from './formats';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
    timeZone: TIME_ZONE,
    now: new Date(),
    formats: APP_FORMATS,
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
