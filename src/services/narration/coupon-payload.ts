import { describeSelection, type Translate } from '@/lib/markets/labels';

/**
 * The narration payload for a coupon, built in exactly one place.
 *
 * The narration cache is keyed on a checksum of this object, so the background
 * job and the page render have to produce byte-identical output — same keys,
 * same order, same rounding — or the job writes an entry the page can never
 * read and every card falls back to the template. Two copies of this shape in
 * two files is precisely how that goes wrong, so there is one.
 */

export interface CouponNarrationSelection {
  homeTeam: string;
  awayTeam: string;
  league: string;
  marketCode: string;
  selectionCode: string;
  odds: number;
  probability: number;
  impliedProbability: number;
  edge: number;
}

export interface CouponNarrationInput {
  reference: string;
  /** Category enum code, e.g. HIGH_VALUE — translated here. */
  category: string;
  totalOdds: number;
  estimatedProbability: number;
  expectedValue: number;
  confidenceScore: number;
  riskScore: number;
  system: { label: string; legs: number; columns: number } | null;
  selections: CouponNarrationSelection[];
}

interface NumberFormatter {
  number: (value: number, format: string) => string;
}

export function buildCouponNarrationPayload(
  input: CouponNarrationInput,
  t: Translate,
  format: NumberFormatter,
): Record<string, unknown> {
  return {
    reference: input.reference,
    category: t(`categories.${input.category}.name`),
    totalOdds: format.number(input.totalOdds, 'odds'),
    modelProbability: format.number(input.estimatedProbability, 'percent'),
    expectedValue: format.number(input.expectedValue, 'signedPercent'),
    confidence: format.number(input.confidenceScore, 'percent'),
    risk: format.number(input.riskScore, 'percent'),
    system: input.system,
    selections: input.selections.map((s) => ({
      match: `${s.homeTeam} - ${s.awayTeam}`,
      league: s.league,
      pick: describeSelection(t, {
        marketCode: s.marketCode,
        selectionCode: s.selectionCode,
        homeTeam: s.homeTeam,
        awayTeam: s.awayTeam,
      }),
      odds: format.number(s.odds, 'odds'),
      modelProbability: format.number(s.probability, 'percent'),
      marketProbability: format.number(s.impliedProbability, 'percent'),
      edge: format.number(s.edge, 'signedPercent'),
    })),
  };
}
