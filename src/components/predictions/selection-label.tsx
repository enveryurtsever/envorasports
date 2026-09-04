import { getTranslations } from 'next-intl/server';
import { findSelection } from '@/lib/markets/registry';

/**
 * Renders a selection code as localized text.
 *
 * The label comes from the market registry, so EN and TR stay in step and a new
 * market needs no UI change. Team placeholders are substituted with the real
 * names rather than showing "home"/"away".
 */
export async function SelectionLabel({
  marketCode,
  selectionCode,
  homeTeam,
  awayTeam,
}: {
  marketCode: string;
  selectionCode: string;
  homeTeam: string;
  awayTeam: string;
}) {
  const t = await getTranslations();
  const definition = marketCode ? findSelection(marketCode, selectionCode) : undefined;

  if (!definition) {
    // No registry entry: show the raw code rather than inventing a label.
    return <span>{selectionCode}</span>;
  }

  const values: Record<string, string | number> = { ...(definition.labelValues ?? {}) };
  if (values.team === 'home') values.team = homeTeam;
  if (values.team === 'away') values.team = awayTeam;

  return <span>{t(definition.labelKey as never, values as never)}</span>;
}
