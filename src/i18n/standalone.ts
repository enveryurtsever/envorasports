import { createFormatter, createTranslator } from 'next-intl';
import { APP_FORMATS, TIME_ZONE } from './formats';
import { INTL_LOCALES, type AppLocale } from './routing';

/**
 * Translator and formatter that work without a request.
 *
 * `getTranslations()` from `next-intl/server` reads the incoming request's
 * locale, so it throws when there is no request to read — which is exactly the
 * case in the scheduler and the narration job. These build the same objects
 * from the message file directly, using the shared formats so background text
 * and rendered pages quote numbers identically.
 */

export interface StandaloneIntl {
  t: (key: string, values?: Record<string, string | number>) => string;
  format: ReturnType<typeof createFormatter>;
}

const cache = new Map<AppLocale, StandaloneIntl>();

export async function getStandaloneIntl(locale: AppLocale): Promise<StandaloneIntl> {
  const cached = cache.get(locale);
  if (cached) return cached;

  const messages = (await import(`./messages/${locale}.json`)).default;

  const translator = createTranslator({ locale: INTL_LOCALES[locale], messages, formats: APP_FORMATS });

  const intl: StandaloneIntl = {
    // Loosened to the plain `Translate` shape the label helpers expect; the
    // narration payload builds keys at runtime, so they cannot be checked here.
    t: translator as unknown as StandaloneIntl['t'],
    format: createFormatter({ locale: INTL_LOCALES[locale], timeZone: TIME_ZONE, formats: APP_FORMATS }),
  };

  cache.set(locale, intl);
  return intl;
}
