import { PrismaClient } from '@prisma/client';
import { namedBetKind } from '../src/lib/providers/api-football/odds-provider';

/**
 * Confirms the provider actually offers the markets the HAYAL signal is stated in.
 *
 * The signal reads two prices the system had never ingested, and the account's
 * daily budget was already spent when the category was built — so the adapter
 * matches these bets on their *name* rather than on a guessed id. This spends
 * one request on `/odds/bets`, the provider's own catalogue, and prints which
 * of its bets the name patterns match.
 *
 * Run it once after the budget resets. If a market is absent from the free
 * plan, the signal cannot be evaluated at all and that is the finding — not
 * something to work around by substituting a different market.
 *
 *   npx tsx scripts/verify-hayal-markets.ts
 */

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const started = Date.now();
  const response = await fetch(`${process.env.FOOTBALL_API_BASE_URL}/odds/bets`, {
    headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY as string },
  });
  const body = (await response.json()) as {
    errors?: unknown;
    response?: Array<{ id: number; name: string }>;
  };

  const errors = body.errors;
  const failed =
    Array.isArray(errors) ? errors.length > 0 : typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0;

  // Logged like any other outbound call, so the budget stays accounted for.
  await prisma.providerRequestLog.create({
    data: {
      provider: 'api-football',
      endpoint: '/odds/bets',
      statusCode: response.status,
      durationMs: Date.now() - started,
      success: !failed,
      attempt: 1,
      cost: 1,
      errorMessage: failed ? JSON.stringify(errors) : null,
    },
  });

  if (failed) {
    console.log('provider refused the catalogue request:', JSON.stringify(errors));
    console.log('nothing can be concluded about market availability from this.');
    await prisma.$disconnect();
    return;
  }

  const bets = body.response ?? [];
  console.log(`provider offers ${bets.length} bet types.\n`);

  const matched = bets
    .map((bet) => ({ ...bet, kind: namedBetKind(bet.name) }))
    .filter((bet) => bet.kind !== null);

  if (matched.length === 0) {
    console.log('NONE of the HAYAL markets are offered on this plan.');
    console.log('The signal cannot be evaluated. Do not substitute another market.');
  } else {
    console.log('HAYAL markets matched:');
    for (const bet of matched) console.log(`  id=${String(bet.id).padStart(4)}  ${bet.kind?.padEnd(18)}  "${bet.name}"`);
  }

  // Anything that reads like a half or a both-teams bet but matched nothing:
  // the patterns may simply be spelled differently than expected.
  const nearby = bets.filter(
    (bet) => !matched.some((m) => m.id === bet.id) && /half|both\s*teams|exact|correct/i.test(bet.name),
  );
  if (nearby.length > 0) {
    console.log('\nRelated bets the patterns did NOT match (check the spelling):');
    for (const bet of nearby) console.log(`  id=${String(bet.id).padStart(4)}  "${bet.name}"`);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
