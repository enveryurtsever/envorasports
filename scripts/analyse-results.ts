import { PrismaClient } from '@prisma/client';
import { settleSelection } from '../src/lib/settlement/evaluators';
import { findSelection } from '../src/lib/markets/registry';

/** How every coupon leg on a finished match actually did. */
const p = new PrismaClient();

async function main() {
  const coupons = await p.coupon.findMany({
    where: { targetDate: { gte: new Date(Date.now() - 2 * 864e5) } },
    select: {
      reference: true, category: true, totalOdds: true, estimatedProbability: true,
      selections: {
        orderBy: { sortOrder: 'asc' },
        select: {
          marketCode: true, selectionCode: true, odds: true, probability: true,
          match: {
            select: {
              status: true, homeScore: true, awayScore: true,
              halfTimeHomeScore: true, halfTimeAwayScore: true,
              homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } },
            },
          },
        },
      },
    },
    orderBy: [{ category: 'asc' }, { reference: 'asc' }],
  });

  let legsDone = 0;
  let legsWon = 0;
  const byMarket = new Map<string, { n: number; won: number }>();

  for (const c of coupons) {
    const parts: string[] = [];
    let decided = 0;
    let won = 0;
    let pending = 0;

    for (const s of c.selections) {
      const m = s.match;
      if (m.status !== 'FINISHED' || m.homeScore === null) { pending++; parts.push(`   ⏳ ${m.homeTeam.name}–${m.awayTeam.name} ${s.selectionCode}`); continue; }

      const def = findSelection(s.marketCode, s.selectionCode);
      const outcome = settleSelection(
        { marketCode: s.marketCode, selectionCode: s.selectionCode, parameters: def?.parameters ?? null, handicap: 0 } as never,
        { status: m.status, homeScore: m.homeScore, awayScore: m.awayScore,
          halfTimeHomeScore: m.halfTimeHomeScore, halfTimeAwayScore: m.halfTimeAwayScore } as never,
      );

      const hit = outcome === 'WON' || outcome === 'HALF_WON';
      decided++; if (hit) won++;
      legsDone++; if (hit) legsWon++;

      const agg = byMarket.get(s.marketCode) ?? { n: 0, won: 0 };
      agg.n++; if (hit) agg.won++;
      byMarket.set(s.marketCode, agg);

      parts.push(`   ${hit ? '✅' : '❌'} ${m.homeTeam.name} ${m.homeScore}-${m.awayScore} ${m.awayTeam.name}  → ${s.selectionCode} @${Number(s.odds).toFixed(2)} (model %${(Number(s.probability)*100).toFixed(0)})`);
    }

    const verdict = pending > 0 ? `${pending} maç sürüyor` : won === decided ? 'KUPON TUTTU' : `KAYBETTİ (${won}/${decided})`;
    console.log(`\n${c.reference} [${c.category}] oran ${Number(c.totalOdds).toFixed(2)} tutma %${(Number(c.estimatedProbability)*100).toFixed(1)} → ${verdict}`);
    for (const line of parts) console.log(line);
  }

  console.log(`\n=== ÖZET ===`);
  console.log(`Sonuçlanan bacak: ${legsDone}, tutan: ${legsWon} (%${legsDone ? (legsWon/legsDone*100).toFixed(1) : '0'})`);
  for (const [market, a] of [...byMarket].sort((x, y) => y[1].n - x[1].n))
    console.log(`   ${market.padEnd(22)} ${a.won}/${a.n}  %${(a.won/a.n*100).toFixed(0)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => p.$disconnect());
