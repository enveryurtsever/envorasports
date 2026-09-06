import { PrismaClient } from '@prisma/client';
import { runBacktest } from '../src/services/backtest/backtest-runner';

/**
 * npx tsx scripts/run-backtest.ts "2025/26 season" 2025-08-01 2026-05-31 [maxMatches]
 */
const prisma = new PrismaClient();

async function main() {
  const name = process.argv[2] ?? 'Walk-forward backtest';
  const from = new Date(process.argv[3] ?? '2025-08-01');
  const to = new Date(process.argv[4] ?? '2026-06-01');
  const maxMatches = process.argv[5] ? Number(process.argv[5]) : undefined;

  const summary = await runBacktest({ name, from, to, folds: 3, maxMatches });

  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);
  console.log(`\n${name}`);
  console.log(`  matches evaluated : ${summary.matchesEvaluated} (skipped ${summary.matchesSkipped})`);
  console.log(`  bets              : ${summary.totalBets}  won ${summary.winningBets} / lost ${summary.losingBets} / void ${summary.voidBets}`);
  console.log(`  hit rate          : ${pct(summary.hitRate)}`);
  console.log(`  average odds      : ${summary.averageOdds?.toFixed(2) ?? '—'}`);
  console.log(`  average edge      : ${pct(summary.averageEdge)}`);
  console.log(`  stake / profit    : ${summary.totalStake.toFixed(2)} / ${summary.profit.toFixed(2)}`);
  console.log(`  ROI               : ${pct(summary.roi)}`);
  console.log(`  max drawdown      : ${summary.maxDrawdown.toFixed(2)}`);
  console.log(`  Brier / log loss  : ${summary.brierScore?.toFixed(4)} / ${summary.logLoss?.toFixed(4)}`);
  console.log('\n  per model (scored on every graded selection it had a view on)');
  console.log('    source     n      Brier   logLoss   bets   acc      ROI');
  for (const m of summary.perModel) {
    console.log(
      `    ${m.source.padEnd(9)} ${String(m.sampleSize).padStart(6)}  ` +
        `${m.brierScore?.toFixed(4) ?? '  —   '}  ${m.logLoss?.toFixed(4) ?? '  —   '}  ` +
        `${String(m.bets).padStart(5)}  ${pct(m.accuracy).padStart(6)}  ${pct(m.roi).padStart(7)}`,
    );
  }

  console.log('\n  calibration (predicted -> observed, n)');
  for (const bucket of summary.calibration) {
    console.log(
      `    ${(bucket.lower * 100).toFixed(0).padStart(3)}-${(bucket.upper * 100).toFixed(0).padStart(3)}%  ` +
        `${(bucket.predicted * 100).toFixed(1).padStart(5)}% -> ${(bucket.observed * 100).toFixed(1).padStart(5)}%  n=${bucket.count}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
