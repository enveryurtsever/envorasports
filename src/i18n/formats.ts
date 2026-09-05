import type { Formats } from 'next-intl';

/** Kickoff times are stored in UTC; the product reads them in Istanbul time. */
export const TIME_ZONE = 'Europe/Istanbul';

/**
 * Shared by the request config and by the standalone translator used off the
 * request path (scheduler, narration job). Keeping one definition is what stops
 * a background-written analysis from quoting odds in a different shape to the
 * card that displays it.
 */
export const APP_FORMATS = {
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
} satisfies Formats;
