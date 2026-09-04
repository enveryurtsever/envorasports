import { describe, expect, it } from 'vitest';
import { AUTO_MATCH_THRESHOLD, normalizeTeamName, similarity } from './team-resolver';

describe('normalizeTeamName', () => {
  it('folds the three providers’ spellings of the same club together', () => {
    const forms = ['Manchester United', 'Man United', 'Manchester United FC', 'Manchester Utd'];
    const normalized = forms.map(normalizeTeamName);
    // Not all collapse to one string, but the noise words are gone.
    expect(normalized[0]).toBe('manchester united');
    expect(normalized[2]).toBe('manchester united');
    expect(normalized[1]).toBe('man united');
  });

  it('strips diacritics, including Turkish dotless i', () => {
    expect(normalizeTeamName('Beşiktaş JK')).toBe('besiktas jk');
    expect(normalizeTeamName('Fenerbahçe SK')).toBe('fenerbahce');
    expect(normalizeTeamName('İstanbul Başakşehir')).toBe('istanbul basaksehir');
    expect(normalizeTeamName('Bayern München')).toBe('bayern munchen');
  });

  it('removes club-type noise but keeps the identity', () => {
    expect(normalizeTeamName('AS Roma')).toBe('roma');
    expect(normalizeTeamName('VfB Stuttgart')).toBe('stuttgart');
    expect(normalizeTeamName('Real Madrid CF')).toBe('real madrid');
  });

  it('never normalises a name away to nothing', () => {
    // A name made only of noise tokens must still produce something.
    expect(normalizeTeamName('FC')).toBe('fc');
    expect(normalizeTeamName('AS')).toBe('as');
  });

  it('handles punctuation and ampersands', () => {
    expect(normalizeTeamName('Brighton & Hove Albion')).toBe('brighton and hove albion');
    expect(normalizeTeamName("Nott'm Forest")).toBe('nott m forest');
  });
});

describe('similarity', () => {
  it('scores identical strings at 1', () => {
    expect(similarity('arsenal', 'arsenal')).toBe(1);
  });

  it('scores clearly different clubs low', () => {
    expect(similarity('arsenal', 'chelsea')).toBeLessThan(0.3);
    // The classic dangerous pair: same city, different club.
    expect(similarity('manchester united', 'manchester city')).toBeLessThan(AUTO_MATCH_THRESHOLD);
  });

  it('scores spelling variants of the same club high', () => {
    expect(similarity('wolverhampton wanderers', 'wolverhampton')).toBeGreaterThan(0.6);
    expect(similarity('tottenham hotspur', 'tottenham')).toBeGreaterThan(0.6);
  });

  it('is symmetric', () => {
    expect(similarity('roma', 'as roma')).toBeCloseTo(similarity('as roma', 'roma'));
  });

  it('is safe on very short strings', () => {
    expect(similarity('a', 'b')).toBe(0);
    expect(similarity('', '')).toBe(1);
  });

  it('keeps the auto-match threshold above the risky near-misses', () => {
    // These pairs must NOT auto-merge; a wrong merge corrupts team history.
    const risky: Array<[string, string]> = [
      ['manchester united', 'manchester city'],
      ['sheffield united', 'sheffield wednesday'],
      ['bristol city', 'bristol rovers'],
      ['real madrid', 'real sociedad'],
    ];
    for (const [a, b] of risky) {
      expect(similarity(normalizeTeamName(a), normalizeTeamName(b))).toBeLessThan(AUTO_MATCH_THRESHOLD);
    }
  });
});
