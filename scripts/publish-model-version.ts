import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Publishes a model version and makes it the active one.
 *
 * Model configuration is data, not code: the engine reads weights and
 * hyper-parameters from the active ModelVersion row, and every prediction
 * stores which version and which config revision produced it. Publishing a new
 * one therefore never rewrites history — the old version and everything
 * predicted under it stay exactly as they were.
 *
 *   npx tsx scripts/publish-model-version.ts
 */

const prisma = new PrismaClient();

/**
 * ensemble v2 — xG switched off, explicitly.
 *
 * The database holds 45,204 match statistic rows and not one of them carries
 * an expected-goals figure, so the xG model reported itself unavailable on
 * every match and the ensemble quietly handed its 0.20 to the other three. The
 * effective model was already poisson 0.50 / elo 0.25 / form 0.25; this states
 * that outright instead of arriving at it by accident. When a source starts
 * supplying xG, that is a new version with a weight above zero — not an edit
 * to this one.
 */
const CONFIGURATION = {
  configVersion: '2026-09-06.1',
  weights: { poisson: 0.5, elo: 0.25, form: 0.25, xg: 0 },
  elo: { kFactor: 20, homeAdvantage: 65, initialRating: 1500, marginWeight: 0.5 },
  poisson: { maxGoals: 10, shrinkage: 0.25, homeAdvantage: 1.12 },
  form: { windows: ['LAST_5', 'LAST_10', 'LAST_20', 'SEASON'], venueSplit: true },
  /**
   * Was a literal in the prediction engine. It changes every stored edge and
   * EV, so it belongs in the versioned configuration where a change to it is
   * visible in the audit trail rather than in a diff.
   */
  marketPriorWeight: 0.35,
  scoring: {
    probabilityWeight: 1,
    valueWeight: 1.5,
    confidenceWeight: 1,
    diversificationWeight: 0.5,
    correlationPenalty: 1.25,
    riskPenalty: 0.75,
  },
  notes: {
    xg: 'disabled: no expected-goals data in any source as of 2026-09-06',
    poissonInput:
      'attack/defence now read the away side from the away team (fixed 2026-09-06)',
  },
} satisfies Prisma.InputJsonObject;

const NAME = 'ensemble';
const VERSION = 'v2';

async function main(): Promise<void> {
  const existing = await prisma.modelVersion.findUnique({
    where: { name_version: { name: NAME, version: VERSION } },
  });

  const published = existing
    ? await prisma.modelVersion.update({
        where: { id: existing.id },
        data: { configuration: CONFIGURATION, active: true },
      })
    : await prisma.modelVersion.create({
        data: {
          name: NAME,
          version: VERSION,
          description:
            'xG disabled explicitly (no data); market prior and config revision moved into configuration.',
          configuration: CONFIGURATION,
          active: true,
        },
      });

  // Exactly one active version: the engine reads `findFirst({ active: true })`.
  const deactivated = await prisma.modelVersion.updateMany({
    where: { active: true, id: { not: published.id } },
    data: { active: false },
  });

  console.log(`${existing ? 'updated' : 'created'} ${NAME} ${VERSION} (${published.id})`);
  console.log(`config revision: ${CONFIGURATION.configVersion}`);
  console.log(`deactivated ${deactivated.count} previous version(s)`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
