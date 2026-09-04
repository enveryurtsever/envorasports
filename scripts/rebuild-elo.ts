import { PrismaClient } from '@prisma/client';
import { rebuildEloRatings } from '../src/services/features/elo';
const prisma = new PrismaClient();
rebuildEloRatings()
  .then((r) => console.log(`matches=${r.matchesProcessed} teams=${r.teamsRated} ratings=${r.ratingsWritten}`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
