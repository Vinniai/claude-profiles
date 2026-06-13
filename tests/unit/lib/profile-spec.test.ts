import { describe, it, expect } from 'vitest';
import {
  parseProfileToken,
  parseProfilesSpec,
} from '../../../src/lib/profile-spec.js';

describe('parseProfileToken', () => {
  it('parses a bare name', () => {
    expect(parseProfileToken('josh')).toEqual({ name: 'josh' });
  });

  it('parses a ratio weight (colon)', () => {
    expect(parseProfileToken('josh:3')).toEqual({ name: 'josh', weight: 3 });
  });

  it('parses a percentage weight (equals)', () => {
    expect(parseProfileToken('josh=50')).toEqual({ name: 'josh', weight: 50 });
  });

  it('accepts hyphens and dots inside the name', () => {
    expect(parseProfileToken('work-max')).toEqual({ name: 'work-max' });
  });

  it('returns null for an option-looking token', () => {
    expect(parseProfileToken('-p')).toBeNull();
  });

  it('throws on a non-numeric weight', () => {
    expect(() => parseProfileToken('josh:abc')).toThrow(/Invalid weight/);
  });

  it('throws on a non-positive weight', () => {
    expect(() => parseProfileToken('josh:0')).toThrow(/Invalid weight/);
  });
});

describe('parseProfilesSpec', () => {
  it('parses a plain comma list', () => {
    expect(parseProfilesSpec('josh,lockie')).toEqual({
      names: ['josh', 'lockie'],
      weights: {},
      hasWeights: false,
    });
  });

  it('parses inline weights and flags hasWeights', () => {
    expect(parseProfilesSpec('josh:3,lockie:1')).toEqual({
      names: ['josh', 'lockie'],
      weights: { josh: 3, lockie: 1 },
      hasWeights: true,
    });
  });

  it('tolerates whitespace around items', () => {
    expect(parseProfilesSpec(' josh , lockie ').names).toEqual(['josh', 'lockie']);
  });

  it('mixes percentage and ratio forms', () => {
    const out = parseProfilesSpec('josh=50,lockie=50');
    expect(out.weights).toEqual({ josh: 50, lockie: 50 });
    expect(out.hasWeights).toBe(true);
  });

  it('rejects duplicate names', () => {
    expect(() => parseProfilesSpec('josh,josh')).toThrow(/more than once/);
  });
});
