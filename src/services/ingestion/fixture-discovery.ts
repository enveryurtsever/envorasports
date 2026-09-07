import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getOddsProvider, THE_ODDS_API } from '@/lib/providers';
import { normalizeTeamName, similarity } from './team-resolver';
import type { ProviderOddsEvent } from '@/lib/providers/types';

const log = createLogger('ingestion:discovery');

/**
 * Football discovery, from the source that does not charge for it.
 *
 * The Odds API meters odds, not enumeration: `/sports` and
 * `/sports/{key}/events` both return `x-requests-last: 0`. Measured on this
 * account, that is 603 upcoming events across 50 competitions for nothing,
 * against a fixture provider with a hard 100 requests a day. Spending that
 * budget to find out which matches exist was the single most expensive habit
 * in the pipeline.
 *
 * Discovery deliberately does not filter to competitions we model. An event in
 * a league we carry no history for still gets recorded — it is never predicted,
 * but it is the difference between "we cover 42 fixtures" and "42 is all there
 * was", and only one of those is a fact.
 */

/** Kickoff tolerance when tying an event to a fixture. */
const KICKOFF_TOLERANCE_MS = 3 * 60 * 60 * 1000;
/**
 * Both sides must clear this before a mapping is trusted for enrichment.
 *
 * Applied to the *weaker* of the two team scores, never the average: a strong
 * home match beside a weak away match is a different fixture, not a spelling
 * variant, and averaging hides exactly that case.
 */
const MAPPING_THRESHOLD = 0.82;
/**
 * The bar for a name matched against every team in the database rather than
 * one competition's. Near-exact only: at 0.82 across thousands of clubs the
 * near-misses stop being spelling variants and start being different teams.
 */
const WIDE_MAPPING_THRESHOLD = 0.95;

export interface DiscoveryResult {
  sportsScanned: number;
  eventsDiscovered: number;
  eventsInWindow: number;
  fixturesUpserted: number;
  newlyMapped: number;
  alreadyMapped: number;
  /** In a competition we model, but no fixture existed to map onto. */
  fixturesCreated: number;
  /** In a competition we model, but a team could not be resolved. */
  unresolvedTeams: number;
  /** In a competition we carry no history for. Recorded, never predicted. */
  outsideModelledLeagues: number;
  unmappable: number;
  creditsSpent: number;
}

export interface DiscoveryOptions {
  /** Only record events kicking off inside this horizon. */
  horizonHours?: number;
  now?: Date;
}

export async function discoverFixtures(
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const now = options.now ?? new Date();
  const horizonHours = options.horizonHours ?? 96;
  const horizon = new Date(now.getTime() + horizonHours * 3600 * 1000);

  const provider = getOddsProvider();
  const result: DiscoveryResult = {
    sportsScanned: 0,
    eventsDiscovered: 0,
    eventsInWindow: 0,
    fixturesUpserted: 0,
    newlyMapped: 0,
    alreadyMapped: 0,
    fixturesCreated: 0,
    unresolvedTeams: 0,
    outsideModelledLeagues: 0,
    unmappable: 0,
    creditsSpent: 0,
  };

  /**
   * Competitions we hold history for, by the provider's own key.
   *
   * Everything else is recorded and left alone: without team history the
   * models cannot run, and a fixture that can never be predicted is not worth
   * creating. What it is worth is being counted, so the gap between what
   * exists and what we cover is visible rather than assumed.
   */
  const modelled = new Map(
    (
      await prisma.league.findMany({
        where: { active: true, oddsApiKey: { not: null } },
        select: { id: true, oddsApiKey: true },
      })
    ).map((league) => [league.oddsApiKey as string, league.id]),
  );

  if (!provider.listEvents) {
    log.warn('provider cannot enumerate events', { provider: provider.name });
    return result;
  }

  const sports = await provider.getSupportedCompetitions();
  const active = sports.filter((sport) => sport.active);
  result.sportsScanned = active.length;

  for (const sport of active) {
    const events = await provider.listEvents(sport.key);
    result.eventsDiscovered += events.length;

    const inWindow = events.filter(
      (event) => event.commenceTimeUtc > now && event.commenceTimeUtc < horizon,
    );
    result.eventsInWindow += inWindow.length;

    const leagueId = modelled.get(sport.key) ?? null;

    for (const event of inWindow) {
      const outcome = await recordDiscoveredFixture(event, sport.key, sport.title, now, leagueId);
      result.fixturesUpserted++;

      switch (outcome) {
        case 'NEW':
          result.newlyMapped++;
          break;
        case 'EXISTING':
          result.alreadyMapped++;
          break;
        case 'CREATED':
          result.fixturesCreated++;
          result.newlyMapped++;
          break;
        case 'UNRESOLVED_TEAMS':
          result.unresolvedTeams++;
          result.unmappable++;
          break;
        case 'NOT_MODELLED':
          result.outsideModelledLeagues++;
          result.unmappable++;
          break;
        default:
          result.unmappable++;
      }
    }
  }

  log.info('fixture discovery complete', { ...result, horizonHours });
  return result;
}

type MappingOutcome =
  | 'NEW'
  | 'EXISTING'
  | 'CREATED'
  | 'UNRESOLVED_TEAMS'
  | 'NOT_MODELLED'
  | 'NONE';

/**
 * Records the event, and ties it to one of our fixtures when it is safe to.
 *
 * Most discovered events map to nothing, because most competitions on the
 * provider are ones we hold no history for. That is recorded as a fact about
 * the event, not as a failure.
 */
async function recordDiscoveredFixture(
  event: ProviderOddsEvent,
  sportKey: string,
  sportTitle: string,
  now: Date,
  leagueId: string | null,
): Promise<MappingOutcome> {
  const existing = await prisma.discoveredFixture.findUnique({
    where: { source_externalEventId: { source: THE_ODDS_API, externalEventId: event.externalId } },
    select: { id: true, matchId: true },
  });

  // Already tied to a fixture: refresh what we saw and stop. Re-running the
  // name match every ten minutes would spend the database for no new answer.
  if (existing?.matchId) {
    await prisma.discoveredFixture.update({
      where: { id: existing.id },
      data: { lastSeenAt: now },
    });
    return 'EXISTING';
  }

  const candidate = await findMatchForEvent(event);

  const data = {
    sportKey,
    sportTitle,
    commenceTimeUtc: event.commenceTimeUtc,
    homeTeamName: event.homeTeamName,
    awayTeamName: event.awayTeamName,
    matchId: candidate?.matchId ?? null,
    lastSeenAt: now,
  };

  await prisma.discoveredFixture.upsert({
    where: { source_externalEventId: { source: THE_ODDS_API, externalEventId: event.externalId } },
    update: data,
    create: { source: THE_ODDS_API, externalEventId: event.externalId, ...data },
  });

  if (candidate) {
    await linkMatch(candidate, event);
    return 'NEW';
  }

  // No fixture to map onto. In a competition we model, that is a gap worth
  // filling: the provider's plan simply has not served this fixture yet, and
  // the event in hand already carries everything a fixture needs.
  if (!leagueId) return 'NOT_MODELLED';

  const created = await createMatchFromEvent(event, leagueId);
  if (!created) return 'UNRESOLVED_TEAMS';

  await prisma.discoveredFixture.update({
    where: { source_externalEventId: { source: THE_ODDS_API, externalEventId: event.externalId } },
    data: { matchId: created },
  });
  await linkMatch(
    {
      matchId: created,
      confidence: 1,
      method: 'created-from-event',
      detail: { event: `${event.homeTeamName} v ${event.awayTeamName}`, sportKey },
    },
    event,
  );
  return 'CREATED';
}

/**
 * Creates a fixture from a discovered event.
 *
 * Only for competitions we already model, and only when both teams are already
 * known — a team is created by the fixture provider, which owns squads and
 * identity. Inventing one here from a bookmaker's spelling would seed the
 * database with duplicates that no later sync could reconcile.
 */
async function createMatchFromEvent(
  event: ProviderOddsEvent,
  leagueId: string,
): Promise<string | null> {
  const [homeTeamId, awayTeamId] = await Promise.all([
    resolveKnownTeam(event.homeTeamName, leagueId),
    resolveKnownTeam(event.awayTeamName, leagueId),
  ]);

  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) return null;

  /**
   * Last check before creating: does this fixture already exist?
   *
   * `findMatchForEvent` looks only at fixtures that are unmapped and still
   * scheduled, because its job is to map. Anything already mapped, or already
   * finished, is invisible to it — so when the fixture provider had served the
   * same match first, nothing was found and a second copy was created beside
   * it. Eighteen of them, each showing SCHEDULED with no score next to a twin
   * that had the result.
   *
   * Teams and kickoff identify a fixture; the mapping state does not.
   */
  const twin = await prisma.match.findFirst({
    where: {
      homeTeamId,
      awayTeamId,
      scheduledKickoffUtc: {
        gte: new Date(event.commenceTimeUtc.getTime() - KICKOFF_TOLERANCE_MS),
        lte: new Date(event.commenceTimeUtc.getTime() + KICKOFF_TOLERANCE_MS),
      },
    },
    select: { id: true, oddsEventExternalId: true },
  });

  if (twin) {
    // Carry the event id over if it has none, so the odds sync can price it.
    if (!twin.oddsEventExternalId) {
      await prisma.match.update({
        where: { id: twin.id },
        data: { oddsEventExternalId: event.externalId },
      });
    }
    return twin.id;
  }

  const season = await prisma.season.findFirst({
    where: { leagueId },
    orderBy: { startDate: 'desc' },
    select: { id: true },
  });
  if (!season) return null;

  const match = await prisma.match.upsert({
    where: {
      source_externalId: { source: THE_ODDS_API, externalId: event.externalId },
    },
    update: { scheduledKickoffUtc: event.commenceTimeUtc, fetchedAt: new Date() },
    create: {
      source: THE_ODDS_API,
      externalId: event.externalId,
      leagueId,
      seasonId: season.id,
      homeTeamId,
      awayTeamId,
      scheduledKickoffUtc: event.commenceTimeUtc,
      status: 'SCHEDULED',
      // The result sync addresses fixtures by the football provider's id, and
      // this fixture has none until that provider serves it. Left null rather
      // than filled with the odds id, which would send it looking for a
      // fixture that does not exist.
      oddsEventExternalId: event.externalId,
    },
    select: { id: true },
  });

  await Promise.all(
    [homeTeamId, awayTeamId].map((teamId) =>
      prisma.teamSeason
        .upsert({
          where: { teamId_seasonId: { teamId, seasonId: season.id } },
          update: {},
          create: { teamId, seasonId: season.id },
        })
        .catch(() => undefined),
    ),
  );

  return match.id;
}

/**
 * A team we already have, matched by name inside its league.
 *
 * Scoped to the league on purpose: club names repeat across countries and
 * divisions, and an unscoped name match is how one club's history ends up
 * behind another club's prediction.
 */
async function resolveKnownTeam(name: string, leagueId: string): Promise<string | null> {
  const normalized = normalizeTeamName(name);

  const select = {
    id: true,
    name: true,
    // Providers spell the same club differently; the alias table is where
    // those spellings have already been reconciled.
    aliases: { select: { alias: true, normalized: true } },
  } as const;

  const inCompetition = await prisma.team.findMany({
    where: { teamSeasons: { some: { season: { leagueId } } } },
    select,
  });

  const rank = (teams: typeof inCompetition) => {
    let best: { id: string; score: number } | null = null;
    for (const team of teams) {
      const names = [team.name, ...team.aliases.map((alias) => alias.alias)];
      const score = Math.max(
        ...names.map((value) => similarity(normalized, normalizeTeamName(value))),
        ...team.aliases.map((alias) => similarity(normalized, alias.normalized)),
      );
      if (!best || score > best.score) best = { id: team.id, score };
    }
    return best;
  };

  // Inside the competition first: club names repeat across countries, and an
  // unscoped match is how one club's history ends up behind another's
  // prediction.
  const scoped = rank(inCompetition);
  if (scoped && scoped.score >= MAPPING_THRESHOLD) return scoped.id;

  /**
   * A cup has no squad of its own.
   *
   * A Champions League tie is played by sides whose only season link is
   * domestic, so the scoped lookup finds nobody and eighteen discovered
   * fixtures produce nothing. Scoping by "the competition has no teams yet"
   * was worse than useless: the first fixture created linked two teams, and
   * every later one was then matched against only those two.
   *
   * So the widening is driven by failure, not by emptiness — and the bar goes
   * up with it, because a wider field is a wider chance of a wrong match.
   * Genuinely unknown sides still fall through: LASK, Bodø/Glimt and Shakhtar
   * score 0.27-0.43 against everything we hold, which is the answer we want.
   */
  const everyone = await prisma.team.findMany({ select });
  const wide = rank(everyone);
  return wide && wide.score >= WIDE_MAPPING_THRESHOLD ? wide.id : null;
}

interface MappingCandidate {
  matchId: string;
  confidence: number;
  method: string;
  detail: Prisma.InputJsonValue;
}

/**
 * Finds our fixture for a provider event: both team names, plus kickoff.
 *
 * Never on names alone. Two clubs share a name across divisions often enough
 * that a name-only join eventually feeds one team's history into another
 * team's prediction, and nothing downstream would look wrong.
 */
async function findMatchForEvent(event: ProviderOddsEvent): Promise<MappingCandidate | null> {
  const candidates = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: {
        gte: new Date(event.commenceTimeUtc.getTime() - KICKOFF_TOLERANCE_MS),
        lte: new Date(event.commenceTimeUtc.getTime() + KICKOFF_TOLERANCE_MS),
      },
      oddsEventExternalId: null,
      status: 'SCHEDULED',
    },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
    take: 300,
  });
  if (candidates.length === 0) return null;

  const home = normalizeTeamName(event.homeTeamName);
  const away = normalizeTeamName(event.awayTeamName);

  let best: MappingCandidate | null = null;
  for (const candidate of candidates) {
    const homeScore = similarity(home, normalizeTeamName(candidate.homeTeam.name));
    const awayScore = similarity(away, normalizeTeamName(candidate.awayTeam.name));
    const confidence = Math.min(homeScore, awayScore);
    if (best && confidence <= best.confidence) continue;

    best = {
      matchId: candidate.id,
      confidence,
      method: homeScore === 1 && awayScore === 1 ? 'exact-name+kickoff' : 'fuzzy-name+kickoff',
      detail: {
        event: `${event.homeTeamName} v ${event.awayTeamName}`,
        fixture: `${candidate.homeTeam.name} v ${candidate.awayTeam.name}`,
        homeScore: Number(homeScore.toFixed(4)),
        awayScore: Number(awayScore.toFixed(4)),
        kickoffDriftMinutes: Math.round(
          (candidate.scheduledKickoffUtc.getTime() - event.commenceTimeUtc.getTime()) / 60_000,
        ),
      },
    };
  }

  if (!best || best.confidence < MAPPING_THRESHOLD) {
    if (best) {
      log.debug('event left unmapped below threshold', {
        event: `${event.homeTeamName} v ${event.awayTeamName}`,
        bestConfidence: Number(best.confidence.toFixed(3)),
      });
    }
    return null;
  }
  return best;
}

/** Writes the mapping in both places: the fast path and the audit trail. */
async function linkMatch(candidate: MappingCandidate, event: ProviderOddsEvent): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: candidate.matchId },
    select: { externalId: true },
  });

  await prisma.$transaction([
    // The fast path every existing query already reads.
    prisma.match.update({
      where: { id: candidate.matchId },
      data: { oddsEventExternalId: event.externalId },
    }),
    // The record of why, so a bad join can be found rather than trusted.
    prisma.externalMatchMapping.upsert({
      where: { matchId: candidate.matchId },
      update: {
        theOddsEventId: event.externalId,
        confidence: new Prisma.Decimal(candidate.confidence.toFixed(4)),
        matchingMethod: candidate.method,
        detail: candidate.detail,
      },
      create: {
        matchId: candidate.matchId,
        theOddsEventId: event.externalId,
        apiFootballFixtureId: match?.externalId ?? null,
        confidence: new Prisma.Decimal(candidate.confidence.toFixed(4)),
        matchingMethod: candidate.method,
        detail: candidate.detail,
      },
    }),
  ]);
}
