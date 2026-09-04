import { PrismaClient } from '@prisma/client';
import { runBacktest } from '../src/services/backtest/backtest-runner';

/**
 * Sweeps a threshold across identical windows so the effect can be read off
 * rather than guessed. Small samples: differences of a few points are noise.
 */
const prisma = new PrismaClient();

async function main() {
  const from = new Date('2026-01-01');
  const to = new Date('2026-06-01');
  const maxMatches = 500;

  console.log('minProb  bets  hit%    avgOdds  ROI%     Brier   logLoss');
  for (const minProbability of [0.05, 0.15, 0.25, 0.35, 0.45, 0.55]) {
    const s = await runBacktest({
      name: `sweep minProb=${minProbability}`,
      from,
      to,
      maxMatches,
      minProbability,
      minEdge: 0.03,
    });

    console.log(
      `${minProbability.toFixed(2).padStart(6)}  ` +
        `${String(s.totalBets).padStart(4)}  ` +
        `${((s.hitRate ?? 0) * 100).toFixed(1).padStart(5)}  ` +
        `${(s.averageOdds ?? 0).toFixed(2).padStart(7)}  ` +
        `${((s.roi ?? 0) * 100).toFixed(2).padStart(7)}  ` +
        `${(s.brierScore ?? 0).toFixed(4)}  ${(s.logLoss ?? 0).toFixed(4)}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
