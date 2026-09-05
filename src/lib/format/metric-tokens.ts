/**
 * One colour per quantity, everywhere.
 *
 * The product shows the same handful of numbers on the front page, the coupon
 * card, the match analysis and the admin editor. If odds are gold in one place
 * and white in another, a reader has to re-learn the page each time. These
 * tokens fix the mapping once.
 *
 * Colour is never the only signal: every value keeps its label, and sign-based
 * quantities also carry an explicit + or -.
 */

export type MetricKey =
  | 'odds'
  | 'modelProbability'
  | 'marketProbability'
  | 'edge'
  | 'expectedValue'
  | 'confidence'
  | 'risk'
  | 'correlation'
  | 'dataQuality'
  | 'stake'
  | 'payout';

export interface MetricToken {
  /** Tailwind text colour. */
  text: string;
  /** Tailwind background for chips and bars. */
  bg: string;
  /** Border for outlined variants. */
  border: string;
  /** Short glyph used alongside the label. */
  glyph: string;
}

export const METRIC_TOKENS: Record<MetricKey, MetricToken> = {
  // What the market charges.
  odds: { text: 'text-gold-light', bg: 'bg-gold/15', border: 'border-gold/40', glyph: '×' },
  // What we think will happen.
  modelProbability: {
    text: 'text-emerald-bright',
    bg: 'bg-emerald-primary/15',
    border: 'border-emerald-primary/40',
    glyph: '◈',
  },
  // What the price implies the market thinks.
  marketProbability: {
    text: 'text-sky-300',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/40',
    glyph: '◇',
  },
  // The gap between the two — the whole point of the product.
  edge: { text: 'text-violet-300', bg: 'bg-violet-500/15', border: 'border-violet-500/40', glyph: '▲' },
  expectedValue: {
    text: 'text-violet-200',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/30',
    glyph: '∑',
  },
  confidence: {
    text: 'text-emerald-bright',
    bg: 'bg-emerald-primary/10',
    border: 'border-emerald-primary/30',
    glyph: '✓',
  },
  risk: { text: 'text-rose-300', bg: 'bg-rose-500/15', border: 'border-rose-500/40', glyph: '⚠' },
  correlation: {
    text: 'text-amber-300',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/40',
    glyph: '≈',
  },
  dataQuality: { text: 'text-sky-200', bg: 'bg-sky-500/10', border: 'border-sky-500/30', glyph: '▦' },
  stake: { text: 'text-paper', bg: 'bg-white/10', border: 'border-white/20', glyph: '₪' },
  payout: { text: 'text-gold-light', bg: 'bg-gold/15', border: 'border-gold/40', glyph: '↑' },
};

/** Sign-aware colour for the quantities that can go either way. */
export function signedTone(key: 'edge' | 'expectedValue', value: number): string {
  if (value > 0) return METRIC_TOKENS[key].text;
  if (value < 0) return 'text-rose-300';
  return 'text-muted';
}
