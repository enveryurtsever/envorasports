import { setRequestLocale } from 'next-intl/server';
import { MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';
import { buildHayalReport, HAYAL_OUTCOME_KEYS, type HayalOutcomeKey } from '@/services/hayal/stats';

export const dynamic = 'force-dynamic';

/**
 * The HAYAL scoreboard.
 *
 * Every number here is computed from graded fixtures. Where there is no sample
 * yet the cell says so rather than showing a zero, because a 0% hit rate and
 * "nothing has been measured" are different statements and only one of them is
 * true today.
 *
 * The lift column is the point of the page: a hit rate on its own says nothing
 * about whether the signal is doing any work. Over 2.5 lands in roughly half of
 * all matches, so a 78% signal cohort is interesting and a 52% one is the
 * bulletin average wearing a label.
 */

const MARKET_LABELS: Record<HayalOutcomeKey, string> = {
  over1_5: '1.5 Üst',
  over2_5: '2.5 Üst',
  over3_5: '3.5 Üst',
  over4_5: '4.5 Üst',
  over5_5: '5.5 Üst',
  over6_5: '6.5 Üst (bilgi)',
  htOver0_5: 'İY 0.5 Üst',
  htOver1_5: 'İY 1.5 Üst',
  htOver2_5: 'İY 2.5 Üst',
  bttsBothHalves: 'İki yarıda da KG',
};

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function signed(value: number | null): string {
  if (value === null) return '—';
  const formatted = `${(value * 100).toFixed(1)}%`;
  return value > 0 ? `+${formatted}` : formatted;
}

function liftTone(value: number | null): string {
  if (value === null) return 'text-neutral-500';
  if (value > 0.02) return 'text-emerald-400';
  if (value < -0.02) return 'text-red-400';
  return 'text-neutral-400';
}

export default async function AdminHayalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const report = await buildHayalReport();
  const noSample = report.baseline.sampleSize === 0;

  return (
    <div className="space-y-8">
      <SectionHeading
        title="🔥 HAYAL"
        description="Yüksek gol market sinyalinin gerçek maçlardaki performansı. Bu sayfa bir iddiayı ölçer; tahmin modelinden bağımsızdır."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Toplam sinyal kaydı" value={String(report.totals.signals)} />
        <MetricCard label="HAYAL adayı" value={String(report.totals.candidates)} />
        <MetricCard label="HAYAL PREMIUM" value={String(report.totals.premium)} />
        <MetricCard
          label="Sonuçlanmış"
          value={String(report.totals.graded)}
          hint="Hit rate yalnızca bu kayıtlardan hesaplanır"
        />
      </div>

      {noSample ? (
        <PremiumCard className="p-6">
          <p className="text-sm text-neutral-300">
            Henüz ölçülecek örneklem yok. Sinyal, &quot;iki yarıda da karşılıklı gol&quot;
            marketinin fiyatını okur; bülten bu marketi fiyatlamaya başlayıp maçlar
            sonuçlandıkça bu tablo kendiliğinden dolar. Buraya örnek veya tahmini
            rakam yazılmaz.
          </p>
        </PremiumCard>
      ) : null}

      <PremiumCard className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="px-4 py-3">Market</th>
              <th className="px-4 py-3 text-right">
                Baseline
                <span className="ml-1 font-normal normal-case text-neutral-500">
                  (n={report.baseline.sampleSize})
                </span>
                {!report.baseline.sufficient ? (
                  <span className="ml-1 font-normal normal-case text-amber-400">
                    · yetersiz örneklem
                  </span>
                ) : null}
              </th>
              {report.cohorts.map((cohort) => (
                <th key={cohort.label} className="px-4 py-3 text-right">
                  {cohort.label}
                  <span className="ml-1 font-normal normal-case text-neutral-500">
                    (n={cohort.sampleSize})
                  </span>
                  {!cohort.sufficient ? (
                    <span className="ml-1 font-normal normal-case text-amber-400">
                      · yetersiz örneklem
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {HAYAL_OUTCOME_KEYS.map((key) => (
              <tr key={key}>
                <td className="px-4 py-2.5 text-neutral-200">{MARKET_LABELS[key]}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-neutral-400">
                  {pct(report.baseline.hitRates[key])}
                </td>
                {report.cohorts.map((cohort) => {
                  const lift = report.lift[cohort.label]?.[key] ?? null;
                  // A rate from a handful of fixtures is shown greyed and
                  // without a lift: the lift is the claim, and there is not
                  // enough behind it to make one.
                  return (
                    <td key={cohort.label} className="px-4 py-2.5 text-right tabular-nums">
                      <span className={cohort.sufficient ? 'text-neutral-100' : 'text-neutral-600'}>
                        {pct(cohort.hitRates[key])}
                      </span>
                      {cohort.sufficient ? (
                        <span className={`ml-2 text-xs ${liftTone(lift)}`}>{signed(lift)}</span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </PremiumCard>

      <SectionHeading
        title="Kuponlar"
        description="HAYAL kuponları normal kuponlardan ayrı hesaplanır."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Kupon" value={String(report.coupons.total)} />
        <MetricCard
          label="Kazanan / sonuçlanan"
          value={`${report.coupons.won} / ${report.coupons.settled}`}
        />
        <MetricCard
          label="Tutma oranı"
          value={pct(report.coupons.winRate)}
          hint={`Fiyatların ima ettiği: ${pct(report.coupons.theoreticalWinRate)}`}
        />
        <MetricCard
          label="Gerçekleşen ROI"
          value={pct(report.coupons.actualRoi)}
          tone={
            report.coupons.actualRoi === null
              ? 'muted'
              : report.coupons.actualRoi > 0
                ? 'emerald'
                : 'rose'
          }
        />
      </div>

      {report.coupons.byVariant.length > 0 ? (
        <PremiumCard className="overflow-x-auto p-0">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-4 py-3">Tür</th>
                <th className="px-4 py-3 text-right">Kupon</th>
                <th className="px-4 py-3 text-right">Sonuçlanan</th>
                <th className="px-4 py-3 text-right">Tutan</th>
                <th className="px-4 py-3 text-right">Oran</th>
                <th className="px-4 py-3 text-right">ROI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {report.coupons.byVariant.map((row) => (
                <tr key={row.variant}>
                  <td className="px-4 py-2.5 text-neutral-200">{row.variant}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.total}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.settled}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.won}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{pct(row.winRate)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{pct(row.roi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PremiumCard>
      ) : null}

      <p className="text-xs leading-relaxed text-neutral-500">
        Ortalama seçim gücü ile kuponun gerçekleşme olasılığı ayrı ölçülerdir: üç
        adet %75&apos;lik ayağın ortalaması %75, birlikte tutma olasılığı %42&apos;dir.
        Tahminler sonuç garantisi değildir.
      </p>
    </div>
  );
}
