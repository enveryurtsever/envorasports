import { describe, expect, it } from 'vitest';
import { normalizeTeamName } from './team-resolver';

/**
 * The containment rule, stated as cases rather than as a regex.
 *
 * These are the exact pairs that were failing: the archive's short names
 * against the odds provider's long ones, and the near-misses that must keep
 * failing.
 */
function isContained(event: string, candidate: string): boolean {
  const a = normalizeTeamName(event);
  const b = normalizeTeamName(candidate);
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 5) return false;
  return longer === shorter || longer.startsWith(`${shorter} `);
}

describe('club name containment', () => {
  it('matches an archive short name to the provider long name', () => {
    expect(isContained('Blackburn Rovers', 'Blackburn')).toBe(true);
    expect(isContained('Cardiff City', 'Cardiff')).toBe(true);
    expect(isContained('Newcastle United', 'Newcastle')).toBe(true);
    expect(isContained('Preston North End', 'Preston')).toBe(true);
    expect(isContained('Swansea City', 'Swansea')).toBe(true);
    expect(isContained('Norwich City', 'Norwich')).toBe(true);
  });

  it('does not match a suffix that is not a prefix', () => {
    // "West Brom" is not the head of "West Bromwich Albion" as whole words.
    expect(isContained('West Bromwich Albion', 'West Brom')).toBe(false);
  });

  it('refuses two clubs that merely share a city', () => {
    // Both contain "manchester", which is why the rule requires a unique
    // candidate rather than trusting containment on its own.
    expect(isContained('Manchester United', 'Manchester City')).toBe(false);
  });

  it('refuses a core too short to identify a club', () => {
    expect(isContained('Real Madrid', 'Real')).toBe(false);
  });

  it('does not confuse different clubs sharing a suffix', () => {
    expect(isContained('Leeds United', 'Dundee United')).toBe(false);
    expect(isContained('Wolverhampton Wanderers', 'Southampton')).toBe(false);
  });
});
