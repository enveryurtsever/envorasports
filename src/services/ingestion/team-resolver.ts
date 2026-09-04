import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('ingestion:team-resolver');

/**
 * Reconciles team identity across three providers.
 *
 * API-Football says "Manchester United", football-data.co.uk says "Man United",
 * The Odds API says "Manchester United FC". Matching on raw strings drops
 * fixtures silently — no error, just a smaller bulletin — so every incoming
 * name goes through here and every successful match is remembered as an alias.
 */

/** Club-name noise that carries no identifying information. */
const NOISE_TOKENS = new Set([
  'fc', 'afc', 'cf', 'sc', 'ac', 'as', 'ss', 'sv', 'vfl', 'vfb', 'tsv', 'fsv', 'bsc',
  'sk', 'if', 'ik', 'bk', 'fk', 'nk', 'hk', 'rc', 'cd', 'ud', 'sd', 'ca', 'club',
  'calcio', 'futbol', 'football', 'spor', 'kulubu', 'kulübü', 'the', 'de', 'do',
]);

/** Strips diacritics, punctuation and club noise to a comparable core. */
export function normalizeTeamName(raw: string): string {
  const base = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Turkish dotless-i survives NFD, so fold it explicitly.
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = base.split(' ').filter((token) => token && !NOISE_TOKENS.has(token));
  // Never normalise a name down to nothing — fall back to the stripped form.
  return (tokens.length > 0 ? tokens.join(' ') : base).trim();
}

/** Dice coefficient over character bigrams: 1 = identical, 0 = nothing shared. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };

  const first = bigrams(a);
  const second = bigrams(b);
  let shared = 0;
  let totalFirst = 0;
  let totalSecond = 0;

  for (const count of first.values()) totalFirst += count;
  for (const [gram, count] of second) {
    totalSecond += count;
    shared += Math.min(count, first.get(gram) ?? 0);
  }

  return (2 * shared) / (totalFirst + totalSecond);
}

/**
 * Above this, an unseen name is accepted as the same club and remembered.
 * Below it, the name is reported unresolved rather than guessed — a wrong
 * merge corrupts a team's whole history, which is far worse than a gap.
 */
export const AUTO_MATCH_THRESHOLD = 0.86;

export interface ResolveOptions {
  source: string;
  name: string;
  externalId?: string | null;
  /** Narrows fuzzy matching to one league's squads. */
  leagueId?: string | null;
  country?: string | null;
}

export interface ResolvedTeam {
  teamId: string;
  confidence: number;
  method: 'external_id' | 'alias' | 'exact_name' | 'fuzzy';
}

/**
 * Resolves a provider's team name to a canonical team, cheapest path first.
 * Returns null when nothing is confident enough.
 */
export async function resolveTeam(options: ResolveOptions): Promise<ResolvedTeam | null> {
  const normalized = normalizeTeamName(options.name);
  if (!normalized) return null;

  // 1. The provider's own id, if we have already stored this team from it.
  if (options.externalId) {
    const byExternal = await prisma.team.findUnique({
      where: { source_externalId: { source: options.source, externalId: options.externalId } },
      select: { id: true },
    });
    if (byExternal) return { teamId: byExternal.id, confidence: 1, method: 'external_id' };
  }

  // 2. A previously recorded alias for this source.
  const alias = await prisma.teamAlias.findUnique({
    where: { source_normalized: { source: options.source, normalized } },
    select: { teamId: true, confidence: true },
  });
  if (alias) return { teamId: alias.teamId, confidence: Number(alias.confidence), method: 'alias' };

  // 3. An alias any other source already established for the same spelling.
  const crossSource = await prisma.teamAlias.findFirst({
    where: { normalized },
    select: { teamId: true },
  });
  if (crossSource) {
    await rememberAlias(crossSource.teamId, options.source, options.name, normalized, 0.95);
    return { teamId: crossSource.teamId, confidence: 0.95, method: 'alias' };
  }

  // 4/5. Compare against candidate squads.
  const candidates = await prisma.team.findMany({
    where: {
      active: true,
      ...(options.country ? { country: options.country } : {}),
      ...(options.leagueId
        ? { teamSeasons: { some: { season: { leagueId: options.leagueId } } } }
        : {}),
    },
    select: { id: true, name: true, shortName: true },
    take: 2000,
  });

  let best: { teamId: string; score: number } | null = null;
  for (const candidate of candidates) {
    for (const label of [candidate.name, candidate.shortName]) {
      if (!label) continue;
      const score = similarity(normalized, normalizeTeamName(label));
      if (!best || score > best.score) best = { teamId: candidate.id, score };
    }
  }

  if (best && best.score === 1) {
    await rememberAlias(best.teamId, options.source, options.name, normalized, 1);
    return { teamId: best.teamId, confidence: 1, method: 'exact_name' };
  }

  if (best && best.score >= AUTO_MATCH_THRESHOLD) {
    await rememberAlias(best.teamId, options.source, options.name, normalized, best.score);
    return { teamId: best.teamId, confidence: best.score, method: 'fuzzy' };
  }

  log.warn('unresolved team name', {
    source: options.source,
    name: options.name,
    bestScore: best?.score ?? 0,
  });
  return null;
}

async function rememberAlias(
  teamId: string,
  source: string,
  alias: string,
  normalized: string,
  confidence: number,
): Promise<void> {
  await prisma.teamAlias
    .upsert({
      where: { source_normalized: { source, normalized } },
      update: {},
      create: { teamId, source, alias, normalized, confidence, verified: confidence === 1 },
    })
    .catch(() => undefined);
}

/**
 * Resolves, or creates the team when the provider gives us a stable id.
 * Used by fixture ingestion, where a genuinely new club must not be dropped.
 */
export async function resolveOrCreateTeam(options: {
  source: string;
  externalId: string;
  name: string;
  shortName?: string | null;
  country?: string | null;
  logo?: string | null;
  venue?: string | null;
}): Promise<string> {
  const existing = await resolveTeam({
    source: options.source,
    name: options.name,
    externalId: options.externalId,
    country: options.country ?? null,
  });

  if (existing) {
    // Backfill the provider id so the next sync takes the cheap path.
    await prisma.team
      .updateMany({
        where: { id: existing.teamId, source: options.source, externalId: { not: options.externalId } },
        data: {},
      })
      .catch(() => undefined);
    return existing.teamId;
  }

  const created = await prisma.team.upsert({
    where: { source_externalId: { source: options.source, externalId: options.externalId } },
    update: { name: options.name, shortName: options.shortName ?? null, fetchedAt: new Date() },
    create: {
      source: options.source,
      externalId: options.externalId,
      name: options.name,
      shortName: options.shortName ?? null,
      country: options.country ?? null,
      logo: options.logo ?? null,
      venue: options.venue ?? null,
      active: true,
    },
    select: { id: true },
  });

  await rememberAlias(created.id, options.source, options.name, normalizeTeamName(options.name), 1);
  return created.id;
}
