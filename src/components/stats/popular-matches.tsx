import { getFormatter, getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import type { getMostPricedMatches } from '@/services/stats/standings';

type Match = Awaited<ReturnType<typeof getMostPricedMatches>>[number];

/**
 * The week's most heavily priced fixtures — a market-derived proxy for "big
 * game", rather than an editorial opinion.
 */
export async function PopularMatches({ matches }: { matches: Match[] }) {
  const t = await getTranslations('weekly');
  const tms = await getTranslations('matchStatus');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  if (matches.length === 0) return null;

  return (
    <PremiumCard className="p-0">
      <h3 className="px-4 pt-4 text-sm font-semibold">{t('popularMatches')}</h3>
      <ul className="mt-3 divide-y divide-white/10">
        {matches.map((match) => (
          <li key={match.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="tabular w-12 text-xs font-semibold text-emerald-bright">
              {format.dateTime(match.kickoffUtc, 'kickoff')}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {match.homeTeam} <span className="text-muted">{tc('vs')}</span> {match.awayTeam}
              </p>
              <p className="text-xs text-muted">{match.league}</p>
            </div>
            {match.homeScore !== null && match.awayScore !== null ? (
              <span className="tabular rounded-md border border-white/15 px-2 py-0.5 text-xs font-semibold">
                {match.homeScore}–{match.awayScore}
              </span>
            ) : (
              <span className="text-xs text-muted">{tms(match.status)}</span>
            )}
            <span className="tabular text-[0.7rem] text-muted-dark">{match.priceCount}</span>
          </li>
        ))}
      </ul>
    </PremiumCard>
  );
}
