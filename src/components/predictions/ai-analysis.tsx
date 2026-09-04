import { getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import { narrate, type NarrationLocale } from '@/lib/narration/narration-service';

const IMPACT_TONE: Record<string, string> = {
  POSITIVE: 'text-emerald-bright',
  NEGATIVE: 'text-rose-300',
  NEUTRAL: 'text-muted',
};

const IMPACT_GLYPH: Record<string, string> = {
  POSITIVE: '↑',
  NEGATIVE: '↓',
  NEUTRAL: '→',
};

/**
 * The written analysis (§19 of the intelligence brief).
 *
 * The payload is assembled by the caller from stored model output; this
 * component only renders what comes back. If the model produced a figure the
 * payload did not contain, the service already discarded it and fell back to
 * the deterministic template — so nothing shown here is invented.
 */
export async function AiAnalysis({
  entityType,
  entityId,
  locale,
  payload,
}: {
  entityType: 'match' | 'coupon' | 'post_match';
  entityId: string;
  locale: NarrationLocale;
  payload: Record<string, unknown>;
}) {
  const t = await getTranslations('analysis');
  const result = await narrate({ entityType, entityId, locale, payload });
  const { narration } = result;

  return (
    <PremiumCard className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-relaxed">{narration.summary}</p>
        <span className="shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-[0.65rem] text-muted">
          {result.source === 'model' ? t('generated') : t('template')}
        </span>
      </div>

      {narration.keyFactors.length > 0 ? (
        <div>
          <h4 className="text-xs tracking-wide text-muted uppercase">{t('keyFactors')}</h4>
          <ul className="mt-2 space-y-2">
            {narration.keyFactors.map((factor, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span aria-hidden className={IMPACT_TONE[factor.impact] ?? 'text-muted'}>
                  {IMPACT_GLYPH[factor.impact] ?? '→'}
                </span>
                <span>
                  <span className="font-medium">{factor.factor}</span>
                  <span className="text-muted"> — {factor.explanation}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {narration.risks.length > 0 ? (
        <div>
          <h4 className="text-xs tracking-wide text-muted uppercase">{t('risks')}</h4>
          <ul className="mt-2 space-y-1">
            {narration.risks.map((risk, i) => (
              <li key={i} className="flex gap-2 text-sm text-muted">
                <span aria-hidden>⚠</span>
                <span>{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {narration.dataLimitations.length > 0 ? (
        <div>
          <h4 className="text-xs tracking-wide text-muted uppercase">{t('dataLimitations')}</h4>
          <ul className="mt-2 space-y-1">
            {narration.dataLimitations.map((limitation, i) => (
              <li key={i} className="text-sm text-muted-dark">
                {limitation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PremiumCard>
  );
}
