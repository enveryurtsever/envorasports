import { runBacktest } from '../src/services/backtest/backtest-runner';

/**
 * Chooses the market-prior weight by measurement.
 *
 * The weight decides how hard a model probability is pulled toward the price.
 * Too low and the model keeps its overconfidence — it called a 14.00 outsider
 * 41.7%. Too high and it just follows the market and has nothing to say. The
 * number that matters is calibration error: how far predicted sits from
 * observed across the buckets.
 */
async function main() {
  const to = new Date();
  const from = new Date(to.getTime() - 400 * 864e5);
  const maxMatches = Number(process.argv[2] ?? 1200);

  console.log('weight  bets   hit%   ROI%     Brier    logLoss  calibErr  worstBucket');
  for (const marketPriorWeight of [0, 0.35, 0.5, 0.65, 0.8, 0.9]) {
    const result = await runBacktest({
      name: `calib w=${marketPriorWeight}`,
      from,
      to,
      minProbability: 0.25,
      maxMatches,
      marketPriorWeight,
    });

    // Mean absolute gap between what was promised and what happened, weighted
    // by how many bets sat in each bucket.
    const buckets = result.calibration.filter((b) => b.count > 0);
    const n = buckets.reduce((s, b) => s + b.count, 0);
    const calibErr = n === 0 ? 0 : buckets.reduce((s, b) => s + b.count * Math.abs(b.predicted - b.observed), 0) / n;
    const worst = buckets.reduce<{ gap: number; label: string }>((acc, b) => {
      const gap = Math.abs(b.predicted - b.observed);
      return b.count >= 20 && gap > acc.gap
        ? { gap, label: `${(b.predicted * 100).toFixed(0)}%->${(b.observed * 100).toFixed(0)}% (n=${b.count})` }
        : acc;
    }, { gap: 0, label: '-' });

    console.log(
      `${marketPriorWeight.toFixed(2).padStart(6)}  ` +
        `${String(result.totalBets).padStart(5)}  ` +
        `${((result.hitRate ?? 0) * 100).toFixed(1).padStart(5)}  ` +
        `${((result.roi ?? 0) * 100).toFixed(2).padStart(6)}  ` +
        `${(result.brierScore ?? 0).toFixed(4).padStart(7)}  ` +
        `${(result.logLoss ?? 0).toFixed(4).padStart(7)}  ` +
        `${(calibErr * 100).toFixed(2).padStart(7)}%  ${worst.label}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
