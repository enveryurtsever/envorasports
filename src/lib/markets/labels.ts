import { findSelection } from './registry';

/**
 * Turns a selection code into readable text.
 *
 * `UNDER_3_5` is an internal identifier, not something to show a reader — and
 * critically, not something to hand the narration model either: given the raw
 * code it writes the raw code back. Everything the reader or the model sees
 * goes through here first.
 */

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface TeamNames {
  home?: string;
  away?: string;
}

/** Human label for one selection, e.g. "Under 3.5" / "3.5 Alt". */
export function formatSelection(
  t: Translate,
  marketCode: string,
  selectionCode: string,
  teams: TeamNames = {},
): string {
  const definition = findSelection(marketCode, selectionCode);
  // No registry entry: show the code rather than inventing a name for it.
  if (!definition) return selectionCode;

  const values: Record<string, string | number> = { ...(definition.labelValues ?? {}) };
  if (values.team === 'home' && teams.home) values.team = teams.home;
  if (values.team === 'away' && teams.away) values.team = teams.away;

  try {
    return t(definition.labelKey, values);
  } catch {
    return definition.name;
  }
}

/** Human label for a market, e.g. "Over / Under" / "Alt / Üst". */
export function formatMarket(t: Translate, marketCode: string): string {
  try {
    return t(`markets.${marketCode}`);
  } catch {
    return marketCode;
  }
}

/**
 * "Over 2.5 — Willem II vs Excelsior", the form used in narration payloads so
 * the written analysis reads as football rather than as database rows.
 */
export function describeSelection(
  t: Translate,
  input: {
    marketCode: string;
    selectionCode: string;
    homeTeam?: string;
    awayTeam?: string;
  },
): string {
  const selection = formatSelection(t, input.marketCode, input.selectionCode, {
    home: input.homeTeam,
    away: input.awayTeam,
  });

  const market = formatMarket(t, input.marketCode);
  return `${selection} (${market})`;
}
