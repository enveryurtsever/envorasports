import { getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import { cn } from '@/lib/format/cn';
import type { LeagueStandings } from '@/services/stats/standings';

const FORM_TONE: Record<string, string> = {
  W: 'bg-emerald-primary/70 text-white',
  D: 'bg-white/20 text-paper',
  L: 'bg-rose-500/60 text-white',
};

/** Computed from stored results — no provider call, no quota. */
export async function StandingsTable({
  standings,
  limit = 8,
}: {
  standings: LeagueStandings;
  limit?: number;
}) {
  const t = await getTranslations('weekly');
  const rows = standings.rows.slice(0, limit);

  return (
    <PremiumCard className="p-0">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
        <div>
          <h3 className="text-sm font-semibold">{standings.leagueName}</h3>
          <p className="text-xs text-muted">
            {standings.country}
            {standings.seasonName ? ` · ${standings.seasonName}` : ''}
          </p>
        </div>
        <span className="text-xs text-muted-dark">
          {standings.matchesPlayed} {t('played')}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">{t('noStandings')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-sm">
            <thead className="border-y border-white/10 text-left text-[0.65rem] text-muted uppercase">
              <tr>
                <th className="py-2 pr-2 pl-4 font-medium">#</th>
                <th className="py-2 font-medium">Team</th>
                <th className="py-2 text-center font-medium">{t('played')}</th>
                <th className="py-2 text-center font-medium">{t('goalDifference')}</th>
                <th className="py-2 text-center font-medium">{t('points')}</th>
                <th className="py-2 pr-4 text-right font-medium">{t('form')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((row) => (
                <tr key={row.teamId}>
                  <td className="tabular py-2 pr-2 pl-4 text-muted">{row.position}</td>
                  <td className="max-w-[10rem] truncate py-2 font-medium">{row.teamName}</td>
                  <td className="tabular py-2 text-center text-muted">{row.played}</td>
                  <td className="tabular py-2 text-center">
                    {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
                  </td>
                  <td className="tabular py-2 text-center font-semibold text-emerald-bright">
                    {row.points}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="flex justify-end gap-0.5">
                      {row.form.map((result, i) => (
                        <span
                          key={i}
                          title={result}
                          className={cn(
                            'inline-flex h-4 w-4 items-center justify-center rounded text-[0.6rem] font-bold',
                            FORM_TONE[result],
                          )}
                        >
                          {result}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PremiumCard>
  );
}
