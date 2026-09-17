import { getFormatter, getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import type { MatchAnalysis } from '@/services/predictions/match-analysis';

type Insight = NonNullable<MatchAnalysis['insight']>;

const IMPORTANCE_TONE: Record<string, string> = {
  key: 'text-gold',
  regular: 'text-foreground',
  fringe: 'text-muted',
};

function signed(value: number, digits = 0): string {
  const pct = value * 100;
  const rounded = pct.toFixed(digits);
  return pct > 0 ? `+${rounded}%` : `${rounded}%`;
}

/**
 * The sourced news reading behind a fixture: what was found, who is out, and
 * how far the model was allowed to move on it. The sources are listed so the
 * reader can check the claim rather than trust the summary.
 */
export async function MatchNews({
  insight,
  locale,
  homeTeam,
  awayTeam,
}: {
  insight: Insight;
  locale: 'tr' | 'en';
  homeTeam: string;
  awayTeam: string;
}) {
  const t = await getTranslations('analysis');
  const format = await getFormatter();
  const summary = locale === 'tr' ? insight.summary.tr : insight.summary.en;

  const side = (name: string, data: Insight['home']) => (
    <div>
      <h4 className="text-xs tracking-wide text-muted uppercase">{name}</h4>
      {data.absentees.length === 0 ? (
        <p className="mt-2 text-sm text-muted-dark">{t('nothingReported')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {data.absentees.map((a, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span aria-hidden className="text-muted">✕</span>
              <span>
                <span className={IMPORTANCE_TONE[a.importance] ?? 'text-foreground'}>{a.name}</span>
                <span className="text-muted"> — {a.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.returning.length > 0 ? (
        <p className="mt-2 text-sm">
          <span className="text-muted">{t('returning')}: </span>
          {data.returning.join(', ')}
        </p>
      ) : null}
      {data.notes.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {data.notes.map((note, i) => (
            <li key={i} className="text-sm text-muted">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  return (
    <PremiumCard className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-relaxed">{summary}</p>
        <span className="shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-[0.65rem] text-muted">
          {t('confidence')} {format.number(insight.confidence, 'percent')}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {side(homeTeam, insight.home)}
        {side(awayTeam, insight.away)}
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">{t('goalEffect')} · {homeTeam}</dt>
          <dd>{signed(insight.adjustments.homeGoals)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('goalEffect')} · {awayTeam}</dt>
          <dd>{signed(insight.adjustments.awayGoals)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('leanEffect')}</dt>
          <dd>
            {insight.adjustments.lean === 0
              ? '—'
              : `${insight.adjustments.lean > 0 ? homeTeam : awayTeam} ${signed(Math.abs(insight.adjustments.lean))}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('readAt')}</dt>
          <dd>{format.dateTime(insight.asOf, { dateStyle: 'short', timeStyle: 'short' })}</dd>
        </div>
      </dl>

      {insight.sources.length > 0 ? (
        <div>
          <h4 className="text-xs tracking-wide text-muted uppercase">{t('sources')}</h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {insight.sources.map((s, i) => (
              <li key={i}>
                <a
                  href={s.uri}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-muted hover:text-foreground"
                >
                  {s.title || new URL(s.uri).hostname}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PremiumCard>
  );
}
