import { PrismaClient } from '@prisma/client';
import { narrate } from '../src/lib/narration/narration-service';
import { findUngroundedNumbers, findBannedLanguage } from '../src/lib/narration/schema';

/** Live check that the narration layer is grounded, in both languages. */
const prisma = new PrismaClient();

async function main() {
  const match = await prisma.match.findFirst({
    where: { predictions: { some: {} } },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
      predictions: {
        orderBy: { predictionTimestamp: 'desc' },
        take: 4,
        select: {
          probability: true, oddsUsed: true, edge: true, breakdown: true,
          selection: { select: { code: true } }, market: { select: { code: true } },
        },
      },
    },
  });
  if (!match) throw new Error('no match with predictions');

  const breakdown = match.predictions[0]?.breakdown as { modelAgreement?: number } | null;
  const payload = {
    homeTeam: match.homeTeam.name,
    awayTeam: match.awayTeam.name,
    league: match.league.name,
    kickoff: match.scheduledKickoffUtc.toISOString(),
    modelAgreement: breakdown?.modelAgreement ?? null,
    selections: match.predictions.map((p) => ({
      market: p.market.code,
      selection: p.selection.code,
      probability: Number(p.probability),
      odds: p.oddsUsed === null ? null : Number(p.oddsUsed),
      edge: p.edge === null ? null : Number(p.edge),
    })),
  };

  for (const locale of ['en', 'tr'] as const) {
    const result = await narrate({ entityType: 'match', entityId: `${match.id}-probe-${Date.now()}`, locale, payload });
    const ungrounded = findUngroundedNumbers(result.narration, payload);
    const banned = findBannedLanguage(result.narration);

    console.log(`\n[${locale}] source=${result.source}${result.reason ? ` reason=${result.reason}` : ''}`);
    console.log(`  summary: ${result.narration.summary}`);
    console.log(`  factors: ${result.narration.keyFactors.length}, risks: ${result.narration.risks.length}, limits: ${result.narration.dataLimitations.length}`);
    if (result.narration.keyFactors[0]) {
      console.log(`  first factor: ${result.narration.keyFactors[0].factor} (${result.narration.keyFactors[0].impact}) — ${result.narration.keyFactors[0].explanation}`);
    }
    console.log(`  ungrounded numbers: ${ungrounded.length}  banned language: ${banned.length}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
