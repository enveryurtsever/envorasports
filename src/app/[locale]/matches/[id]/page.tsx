import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { getViewer } from '@/lib/auth/session';
import { getMatchAnalysis } from '@/services/predictions/match-analysis';
import { Link } from '@/i18n/navigation';
import { EmptyState, MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';
import { SelectionLabel } from '@/components/predictions/selection-label';
import { FactorBars } from '@/components/predictions/factor-bars';
import { AiAnalysis } from '@/components/predictions/ai-analysis';

export const dynamic = 'force-dynamic';

/** Match analysis (§47). Every figure is read back from stored model output. */
export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const viewer = await getViewer();
  const analysis = await getMatchAnalysis(id, viewer);
  if (!analysis) notFound();

  const t = await getTranslations('matches');
  const tm = await getTranslations('metrics');
  const tMarket = await getTranslations('markets');
  const tms = await getTranslations('matchStatus');
  const tc = await getTranslations('common');
  const te = await getTranslations('entitlement');
  const tp = await getTranslations('predictions');
  const tAnalysis = await getTranslations('analysis');
  const format = await getFormatter();

  const { match } = analysis;
  const finished = match.homeScore !== null && match.awayScore !== null;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs tracking-wide text-muted uppercase">
          {match.league}
          {match.country ? ` · ${match.country}` : ''}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {match.homeTeam} <span className="text-muted">{tc('vs')}</span> {match.awayTeam}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {format.dateTime(match.kickoffUtc, 'full')} · {tms(match.status)}
          {match.venue ? ` · ${match.venue}` : ''}
        </p>

        {finished ? (
          <p className="tabular mt-3 text-3xl font-semibold">
            {match.homeScore} – {match.awayScore}
            {match.halfTimeHomeScore !== null ? (
              <span className="ml-3 text-sm font-normal text-muted">
                {t('halfTimeScore')} {match.halfTimeHomeScore}–{match.halfTimeAwayScore}
              </span>
            ) : null}
          </p>
        ) : null}
      </header>

      {!analysis.hasPredictions ? (
        <EmptyState title={t('noOdds')} hint={tp('noneForCategoryHint')} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <MetricCard
              label={tm('modelProbability')}
              value={analysis.modelVersion ?? tc('notAvailable')}
              tone="muted"
            />
            <MetricCard
              label={tm('correlation')}
              value={
                analysis.modelAgreement === null
                  ? tc('notAvailable')
                  : format.number(analysis.modelAgreement, 'percent')
              }
              hint={tp('modelAgreement')}
              tone="emerald"
            />
            <MetricCard
              label={t('form')}
              value={analysis.form ? analysis.form.home.results.join(' ') : tc('notAvailable')}
              hint={match.homeTeam}
              tone="muted"
            />
            <MetricCard
              label={t('form')}
              value={analysis.form ? analysis.form.away.results.join(' ') : tc('notAvailable')}
              hint={match.awayTeam}
              tone="muted"
            />
          </div>

          {Object.entries(analysis.byMarket).map(([marketCode, rows]) => (
            <section key={marketCode}>
              <SectionHeading title={tMarket(marketCode)} />
              <PremiumCard className="overflow-x-auto p-0">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="border-b border-white/10 text-left text-xs text-muted uppercase">
                    <tr>
                      <th className="px-4 py-2">{tp('title')}</th>
                      <th className="px-4 py-2 text-right">{tm('modelProbability')}</th>
                      <th className="px-4 py-2 text-right">{tm('impliedProbability')}</th>
                      <th className="px-4 py-2 text-right">{tm('odds')}</th>
                      <th className="px-4 py-2 text-right">{tm('edge')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {rows.map((row) => (
                      <tr key={row.selectionCode}>
                        <td className="px-4 py-2">
                          <SelectionLabel
                            marketCode={marketCode}
                            selectionCode={row.selectionCode}
                            homeTeam={match.homeTeam}
                            awayTeam={match.awayTeam}
                          />
                        </td>
                        <td className="tabular px-4 py-2 text-right font-semibold">
                          {format.number(row.probability, 'percent')}
                        </td>
                        <td className="tabular px-4 py-2 text-right text-muted">
                          {row.impliedProbability === null
                            ? '—'
                            : format.number(row.impliedProbability, 'percent')}
                        </td>
                        <td className="tabular px-4 py-2 text-right">
                          {row.odds === null ? '—' : format.number(row.odds, 'odds')}
                        </td>
                        <td
                          className={`tabular px-4 py-2 text-right ${
                            (row.edge ?? 0) > 0 ? 'text-emerald-bright' : 'text-muted'
                          }`}
                        >
                          {row.edge === null ? '—' : format.number(row.edge, 'signedPercent')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </PremiumCard>
            </section>
          ))}

          <section>
            <SectionHeading title={tp('why')} description={tp('whyDescription')} />
            <FactorBars factors={analysis.factors} perModel={analysis.perModel} />
          </section>

          <section>
            <SectionHeading title={tAnalysis('title')} description={tAnalysis('grounding')} />
            <AiAnalysis
              entityType={finished ? 'post_match' : 'match'}
              entityId={match.id}
              locale={locale === 'tr' ? 'tr' : 'en'}
              payload={{
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                league: match.league,
                status: match.status,
                kickoff: match.kickoffUtc.toISOString(),
                finalScore:
                  match.homeScore !== null && match.awayScore !== null
                    ? { home: match.homeScore, away: match.awayScore }
                    : null,
                modelAgreement: analysis.modelAgreement,
                modelVersion: analysis.modelVersion,
                perModelResult: analysis.perModel,
                features: analysis.features,
                form: analysis.form,
                elo: analysis.elo,
                headToHead: analysis.headToHead.map((h) => ({
                  date: h.date.toISOString().slice(0, 10),
                  score: `${h.homeScore}-${h.awayScore}`,
                })),
                topMarkets: Object.fromEntries(
                  Object.entries(analysis.byMarket).map(([code, rows]) => [
                    code,
                    rows.slice(0, 3).map((r) => ({
                      selection: r.selectionCode,
                      probability: r.probability,
                      odds: r.odds,
                      edge: r.edge,
                    })),
                  ]),
                ),
                hasXg: Object.keys(analysis.features).includes('xg'),
              }}
            />
          </section>

          <section>
            <SectionHeading title={tp('valueOpportunities')} />
            {analysis.valueSelections.length > 0 ? (
              <PremiumCard className="p-0">
                <ul className="divide-y divide-white/10">
                  {analysis.valueSelections.map((selection) => (
                    <li
                      key={selection.selectionCode}
                      className="flex flex-wrap items-center gap-3 px-4 py-3"
                    >
                      <span className="min-w-0 flex-1 text-sm font-medium">
                        <SelectionLabel
                          marketCode=""
                          selectionCode={selection.selectionCode}
                          homeTeam={match.homeTeam}
                          awayTeam={match.awayTeam}
                        />
                      </span>
                      <span className="tabular text-sm">
                        {selection.odds === null ? '—' : format.number(selection.odds, 'odds')}
                      </span>
                      <span className="tabular text-sm text-emerald-bright">
                        {selection.edge === null
                          ? '—'
                          : format.number(selection.edge, 'signedPercent')}
                      </span>
                    </li>
                  ))}
                </ul>
              </PremiumCard>
            ) : (
              <PremiumCard accent="gold">
                <p className="text-sm text-muted">{te('lockedHint')}</p>
                <Link
                  href="/pricing"
                  className="mt-3 inline-block rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-ink"
                >
                  {te('seePlans')}
                </Link>
              </PremiumCard>
            )}
          </section>

          {analysis.headToHead.length > 0 ? (
            <section>
              <SectionHeading title={t('headToHead')} />
              <PremiumCard className="p-0">
                <ul className="divide-y divide-white/10">
                  {analysis.headToHead.map((meeting, i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="w-24 shrink-0 text-xs text-muted">
                        {format.dateTime(meeting.date, 'short')}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {meeting.homeTeam} – {meeting.awayTeam}
                      </span>
                      <span className="tabular font-semibold">
                        {meeting.homeScore}–{meeting.awayScore}
                      </span>
                    </li>
                  ))}
                </ul>
              </PremiumCard>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
