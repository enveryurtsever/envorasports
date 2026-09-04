import { getFormatter, getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import type { FactorBar } from '@/services/predictions/match-analysis';

/**
 * "Why this pick" (§48, and §32 of the intelligence brief).
 *
 * Every bar is a stored model output with its source named. Nothing here is a
 * narrative flourish — if a factor was not computed, it does not get a bar.
 */
export async function FactorBars({
  factors,
  perModel,
}: {
  factors: FactorBar[];
  perModel: Record<string, Record<string, number>>;
}) {
  const t = await getTranslations('factors');
  const tp = await getTranslations('predictions');
  const format = await getFormatter();

  if (factors.length === 0) {
    return <PremiumCard><p className="text-sm text-muted">{tp('whyEmpty')}</p></PremiumCard>;
  }

  const models = Object.entries(perModel);

  return (
    <PremiumCard className="space-y-4">
      <ul className="space-y-2">
        {factors.map((factor) => (
          <li key={factor.key} className="flex items-center gap-3">
            <span className="w-36 shrink-0 text-sm">{t(factor.key)}</span>
            <span
              role="meter"
              aria-valuenow={Math.round(factor.value * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t(factor.key)}
              className="h-2 flex-1 overflow-hidden rounded-full bg-white/10"
            >
              <span
                className="block h-full bg-emerald-primary"
                style={{ width: `${Math.max(2, Math.min(100, factor.value * 100))}%` }}
              />
            </span>
            <span className="tabular w-12 text-right text-sm font-semibold">
              {Math.round(factor.value * 100)}
            </span>
          </li>
        ))}
      </ul>

      {models.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-xs">
            <thead className="text-left text-muted uppercase">
              <tr>
                <th className="py-1">{tp('model')}</th>
                <th className="py-1 text-right">1</th>
                <th className="py-1 text-right">X</th>
                <th className="py-1 text-right">2</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {models.map(([name, view]) => (
                <tr key={name}>
                  <td className="py-1 font-medium">{name}</td>
                  <td className="tabular py-1 text-right">{format.number(view.MS_1 ?? 0, 'percent')}</td>
                  <td className="tabular py-1 text-right">{format.number(view.MS_X ?? 0, 'percent')}</td>
                  <td className="tabular py-1 text-right">{format.number(view.MS_2 ?? 0, 'percent')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </PremiumCard>
  );
}
