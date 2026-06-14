import { describe, it, expect } from 'vitest';
import {
  parseUsageFromText,
  mergeBudget,
  pctRemaining,
  windowEndsInMs,
  windowEndsWithinMin,
  isStale,
  formatBudget,
  USAGE_STALE_MS,
} from '../../../src/lib/usage.js';
import type { UsageBudget, UsageWindow } from '../../../src/types/index.js';

// Fixed clock used everywhere so all assertions are deterministic.
const NOW = new Date('2026-06-12T12:00:00.000Z');

// ---------------------------------------------------------------------------
// parseUsageFromText
// ---------------------------------------------------------------------------

describe('parseUsageFromText', () => {
  describe('weekly percentage', () => {
    it('parses "N% of your weekly limit"', () => {
      const b = parseUsageFromText('You have used 75% of your weekly limit.', NOW);
      expect(b.weekly?.usedPct).toBe(75);
      expect(b.session).toBeUndefined();
    });

    it('parses "weekly limit: 80% used"', () => {
      const b = parseUsageFromText('weekly limit: 80% used', NOW);
      expect(b.weekly?.usedPct).toBe(80);
    });

    it('inverts "N% of your weekly limit remaining" to usedPct = 100 - N', () => {
      const b = parseUsageFromText('20% of your weekly limit remaining', NOW);
      expect(b.weekly?.usedPct).toBe(80);
    });

    it('inverts "N% of your weekly limit left"', () => {
      const b = parseUsageFromText('30% of your weekly limit left', NOW);
      expect(b.weekly?.usedPct).toBe(70);
    });

    it('parses "weekly ... N% remaining" pattern', () => {
      const b = parseUsageFromText('Your weekly budget: 10% remaining', NOW);
      expect(b.weekly?.usedPct).toBe(90);
    });
  });

  describe('session percentage', () => {
    it('parses "N% of your session limit"', () => {
      const b = parseUsageFromText('50% of your session limit', NOW);
      expect(b.session?.usedPct).toBe(50);
      expect(b.weekly).toBeUndefined();
    });

    it('parses "session limit: 40% used"', () => {
      const b = parseUsageFromText('session limit: 40% used', NOW);
      expect(b.session?.usedPct).toBe(40);
    });

    it('parses "5-hour ... 60%"', () => {
      const b = parseUsageFromText('5-hour limit: 60% used', NOW);
      expect(b.session?.usedPct).toBe(60);
    });

    it('parses "5 hour" (space variant) as session', () => {
      const b = parseUsageFromText('5 hour limit: 35% used', NOW);
      expect(b.session?.usedPct).toBe(35);
    });

    it('inverts "N% of your session limit remaining"', () => {
      const b = parseUsageFromText('25% of your session limit remaining', NOW);
      expect(b.session?.usedPct).toBe(75);
    });
  });

  describe('reset time — epoch', () => {
    it('parses a 10-digit unix epoch (seconds) and converts to ISO', () => {
      const epoch = 1718200800; // seconds
      const b = parseUsageFromText(`Your limit resets_at: ${epoch}`, NOW);
      // Should associate with session (no "week" in context)
      expect(b.session?.resetAt).toBe(new Date(epoch * 1000).toISOString());
    });

    it('parses a 13-digit epoch (milliseconds) as-is', () => {
      const epochMs = 1718200800000;
      const b = parseUsageFromText(`resets_at: ${epochMs}`, NOW);
      expect(b.session?.resetAt).toBe(new Date(epochMs).toISOString());
    });

    it('associates epoch reset with weekly when context mentions "week"', () => {
      const epoch = 1718200800;
      const b = parseUsageFromText(`weekly limit resets_at: ${epoch}`, NOW);
      expect(b.weekly?.resetAt).toBe(new Date(epoch * 1000).toISOString());
      expect(b.session).toBeUndefined();
    });
  });

  describe('reset time — human clock', () => {
    // NOW = 2026-06-12T12:00:00.000Z (UTC noon).
    // Human-clock parsing uses local wall-clock time (same as claude-errors),
    // so the exact UTC hour in the result depends on the test machine's timezone.
    // Tests use local-time helpers to stay timezone-agnostic.

    /** Build the expected Date for h:mm localtime on NOW's local date, rolling to
     *  tomorrow if that local time has already passed. */
    function expectedLocalReset(h: number, m: number): Date {
      const d = new Date(NOW);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= NOW.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }

    it('parses "resets at 3:45pm" — result is in the future and local time matches', () => {
      const b = parseUsageFromText('Your limit resets at 3:45pm', NOW);
      const resetDate = new Date(b.session!.resetAt!);
      const expected = expectedLocalReset(15, 45);
      expect(resetDate.getTime()).toBe(expected.getTime());
      expect(resetDate.getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('rolls to tomorrow when the local time has already passed today', () => {
      // Use a time that is definitely before NOW in local clock terms.
      // local NOW = new Date('2026-06-12T12:00:00.000Z').getHours()
      const nowLocalHour = NOW.getHours();
      // pick an hour two hours before local NOW (wraps to 0 if needed, but we'll
      // just use "1:00am" which should always be before any reasonable timezone's noon
      const b = parseUsageFromText('resets at 1:00am', NOW);
      const resetDate = new Date(b.session!.resetAt!);
      const expected = expectedLocalReset(1, 0);
      expect(resetDate.getTime()).toBe(expected.getTime());
      expect(resetDate.getTime()).toBeGreaterThan(NOW.getTime());
      // Should be tomorrow local date
      const tomorrowLocal = new Date(NOW);
      tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
      expect(resetDate.getDate()).toBe(tomorrowLocal.getDate());
      // suppress unused-variable warning
      void nowLocalHour;
    });

    it('parses 24h time "resets at 14:30" — local 14:30', () => {
      const b = parseUsageFromText('resets at 14:30', NOW);
      const resetDate = new Date(b.session!.resetAt!);
      const expected = expectedLocalReset(14, 30);
      expect(resetDate.getTime()).toBe(expected.getTime());
      // local hours must be 14
      expect(resetDate.getHours()).toBe(14);
      expect(resetDate.getMinutes()).toBe(30);
    });

    it('parses "resets at 2:00" (past local noon when NOW is afternoon) - future result', () => {
      // 2:00 local time is almost certainly before local NOW (which is noon UTC)
      // unless the timezone is far east. We just test the result is in the future.
      const b = parseUsageFromText('resets at 2:00', NOW);
      const resetDate = new Date(b.session!.resetAt!);
      expect(resetDate.getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('associates human reset with weekly when context mentions "week"', () => {
      const b = parseUsageFromText('weekly limit resets at 6:00pm', NOW);
      expect(b.weekly?.resetAt).toBeDefined();
      expect(b.session).toBeUndefined();
    });

    it('does not mis-read a space-separated bare epoch as a clock time', () => {
      // "resets at 1718200000" has no :/= so epochRe skips it; the clock regex
      // must NOT grab the leading "17" and record a bogus ~5pm reset.
      const b = parseUsageFromText('resets at 1718200000', NOW);
      expect(b.session?.resetAt).toBeUndefined();
      expect(b.weekly?.resetAt).toBeUndefined();
    });
  });

  describe('observedAt + source stamping', () => {
    it('stamps observedAt = now.toISOString() on a found window', () => {
      const b = parseUsageFromText('session limit: 50% used', NOW);
      expect(b.session?.observedAt).toBe(NOW.toISOString());
      expect(b.session?.source).toBe('observed');
    });

    it('stamps both windows independently when both are found', () => {
      const b = parseUsageFromText(
        'session limit: 50% used. weekly limit: 80% used.',
        NOW,
      );
      expect(b.session?.observedAt).toBe(NOW.toISOString());
      expect(b.weekly?.observedAt).toBe(NOW.toISOString());
    });
  });

  describe('garbage / missing input', () => {
    it('returns {} for empty string', () => {
      expect(parseUsageFromText('')).toEqual({});
    });

    it('returns {} for unrelated text', () => {
      expect(parseUsageFromText('Hello world, everything is fine!')).toEqual({});
    });

    it('returns {} for text with unrelated numbers', () => {
      expect(parseUsageFromText('error code 500 at 12:00')).toEqual({});
    });

    it('never throws on malformed input', () => {
      expect(() =>
        parseUsageFromText('% of your %%% limit NaN% used limit:', NOW),
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// mergeBudget
// ---------------------------------------------------------------------------

describe('mergeBudget', () => {
  const windowA: UsageWindow = {
    usedPct: 40,
    resetAt: '2026-06-12T18:00:00.000Z',
    observedAt: '2026-06-12T10:00:00.000Z',
    source: 'observed',
  };
  const windowB: UsageWindow = {
    usedPct: 60,
    observedAt: '2026-06-12T11:00:00.000Z',
    source: 'observed',
  };

  it('next fields win over prev when both windows are present', () => {
    const prev: UsageBudget = { session: windowA };
    const next: UsageBudget = { session: windowB };
    const merged = mergeBudget(prev, next);
    expect(merged.session?.usedPct).toBe(60);
    // resetAt from prev is preserved because next doesn't define it
    expect(merged.session?.resetAt).toBe(windowA.resetAt);
    expect(merged.session?.observedAt).toBe(windowB.observedAt);
  });

  it('keeps prev window when next has no data for that window', () => {
    const prev: UsageBudget = { session: windowA, weekly: { usedPct: 70 } };
    const next: UsageBudget = { session: windowB };
    const merged = mergeBudget(prev, next);
    expect(merged.weekly?.usedPct).toBe(70);
  });

  it('takes next window when prev has none', () => {
    const prev: UsageBudget = {};
    const next: UsageBudget = { weekly: { usedPct: 55 } };
    const merged = mergeBudget(prev, next);
    expect(merged.weekly?.usedPct).toBe(55);
  });

  it('handles undefined prev', () => {
    const merged = mergeBudget(undefined, { session: windowA });
    expect(merged.session?.usedPct).toBe(40);
  });

  it('handles undefined next', () => {
    const merged = mergeBudget({ session: windowA }, undefined);
    expect(merged.session?.usedPct).toBe(40);
  });

  it('handles both undefined', () => {
    expect(mergeBudget(undefined, undefined)).toEqual({});
  });

  it('does not mutate prev', () => {
    const prev: UsageBudget = { session: { usedPct: 10 } };
    const next: UsageBudget = { session: { usedPct: 90 } };
    mergeBudget(prev, next);
    expect(prev.session?.usedPct).toBe(10);
  });

  it('does not mutate next', () => {
    const prev: UsageBudget = { session: { usedPct: 10 } };
    const next: UsageBudget = { session: { usedPct: 90 } };
    mergeBudget(prev, next);
    expect(next.session?.usedPct).toBe(90);
  });

  it('field-level merge: next undefined fields do not overwrite prev', () => {
    const prev: UsageBudget = {
      session: { usedPct: 30, resetAt: '2026-06-12T18:00:00.000Z', source: 'manual' },
    };
    const next: UsageBudget = {
      session: { usedPct: 50 }, // no resetAt, no source
    };
    const merged = mergeBudget(prev, next);
    expect(merged.session?.usedPct).toBe(50);
    expect(merged.session?.resetAt).toBe('2026-06-12T18:00:00.000Z');
    expect(merged.session?.source).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// pctRemaining
// ---------------------------------------------------------------------------

describe('pctRemaining', () => {
  it('returns 100 - usedPct', () => {
    expect(pctRemaining({ usedPct: 60 })).toBe(40);
  });

  it('returns 0 when fully exhausted', () => {
    expect(pctRemaining({ usedPct: 100 })).toBe(0);
  });

  it('returns 100 when nothing used', () => {
    expect(pctRemaining({ usedPct: 0 })).toBe(100);
  });

  it('clamps to 0 for over-budget values', () => {
    expect(pctRemaining({ usedPct: 110 })).toBe(0);
  });

  it('clamps to 100 for negative usedPct', () => {
    expect(pctRemaining({ usedPct: -5 })).toBe(100);
  });

  it('returns undefined when usedPct is absent', () => {
    expect(pctRemaining({ resetAt: '2026-06-12T18:00:00.000Z' })).toBeUndefined();
  });

  it('returns undefined for undefined window', () => {
    expect(pctRemaining(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// windowEndsInMs
// ---------------------------------------------------------------------------

describe('windowEndsInMs', () => {
  it('returns ms until resetAt when it is in the future', () => {
    const resetAt = new Date(NOW.getTime() + 60_000).toISOString();
    expect(windowEndsInMs({ resetAt }, NOW)).toBe(60_000);
  });

  it('clamps to 0 when resetAt is in the past', () => {
    const resetAt = new Date(NOW.getTime() - 5_000).toISOString();
    expect(windowEndsInMs({ resetAt }, NOW)).toBe(0);
  });

  it('returns undefined when no resetAt', () => {
    expect(windowEndsInMs({ usedPct: 50 }, NOW)).toBeUndefined();
  });

  it('returns undefined for undefined window', () => {
    expect(windowEndsInMs(undefined, NOW)).toBeUndefined();
  });

  it('returns undefined for invalid resetAt', () => {
    expect(windowEndsInMs({ resetAt: 'not-a-date' }, NOW)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// windowEndsWithinMin
// ---------------------------------------------------------------------------

describe('windowEndsWithinMin', () => {
  it('returns true when window ends exactly at the limit', () => {
    const resetAt = new Date(NOW.getTime() + 30 * 60_000).toISOString(); // 30 min
    expect(windowEndsWithinMin({ resetAt }, 30, NOW)).toBe(true);
  });

  it('returns true when window ends before the limit', () => {
    const resetAt = new Date(NOW.getTime() + 5 * 60_000).toISOString(); // 5 min
    expect(windowEndsWithinMin({ resetAt }, 30, NOW)).toBe(true);
  });

  it('returns false when window ends after the limit', () => {
    const resetAt = new Date(NOW.getTime() + 60 * 60_000).toISOString(); // 60 min
    expect(windowEndsWithinMin({ resetAt }, 30, NOW)).toBe(false);
  });

  it('returns false for undefined window', () => {
    expect(windowEndsWithinMin(undefined, 30, NOW)).toBe(false);
  });

  it('returns false when no resetAt', () => {
    expect(windowEndsWithinMin({ usedPct: 50 }, 30, NOW)).toBe(false);
  });

  it('returns true when window is already past (clamped to 0 ms)', () => {
    const resetAt = new Date(NOW.getTime() - 1000).toISOString();
    expect(windowEndsWithinMin({ resetAt }, 10, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe('isStale', () => {
  it('returns false when observation is fresh', () => {
    const observedAt = new Date(NOW.getTime() - 1_000).toISOString(); // 1 s ago
    expect(isStale({ observedAt }, USAGE_STALE_MS, NOW)).toBe(false);
  });

  it('returns true when observation is older than maxAgeMs', () => {
    const observedAt = new Date(NOW.getTime() - (USAGE_STALE_MS + 1)).toISOString();
    expect(isStale({ observedAt }, USAGE_STALE_MS, NOW)).toBe(true);
  });

  it('returns false exactly at the boundary (equal age)', () => {
    const observedAt = new Date(NOW.getTime() - USAGE_STALE_MS).toISOString();
    // NOW - observedMs = USAGE_STALE_MS, NOT > maxAgeMs, so still fresh
    expect(isStale({ observedAt }, USAGE_STALE_MS, NOW)).toBe(false);
  });

  it('returns true when observedAt is missing', () => {
    expect(isStale({ usedPct: 50 }, USAGE_STALE_MS, NOW)).toBe(true);
  });

  it('returns true for undefined window', () => {
    expect(isStale(undefined, USAGE_STALE_MS, NOW)).toBe(true);
  });

  it('returns true for invalid observedAt', () => {
    expect(isStale({ observedAt: 'bad-date' }, USAGE_STALE_MS, NOW)).toBe(true);
  });

  it('works with a custom maxAgeMs', () => {
    const oneMin = 60_000;
    const observedAt = new Date(NOW.getTime() - 61_000).toISOString();
    expect(isStale({ observedAt }, oneMin, NOW)).toBe(true);
    const observedAtFresh = new Date(NOW.getTime() - 59_000).toISOString();
    expect(isStale({ observedAtFresh: observedAtFresh } as UsageWindow, oneMin, NOW)).toBe(true);
    expect(isStale({ observedAt: observedAtFresh }, oneMin, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatBudget
// ---------------------------------------------------------------------------

describe('formatBudget', () => {
  it('formats both windows', () => {
    const b: UsageBudget = {
      session: { usedPct: 50 },
      weekly: { usedPct: 80 },
    };
    expect(formatBudget(b)).toBe('session 50% · weekly 80%');
  });

  it('formats session only', () => {
    expect(formatBudget({ session: { usedPct: 40 } })).toBe('session 40%');
  });

  it('formats weekly only', () => {
    expect(formatBudget({ weekly: { usedPct: 90 } })).toBe('weekly 90%');
  });

  it('returns "—" for an empty budget', () => {
    expect(formatBudget({})).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(formatBudget(undefined)).toBe('—');
  });

  it('omits a window that has resetAt but no usedPct still shows (reset known)', () => {
    const b: UsageBudget = {
      session: { resetAt: '2026-06-12T18:00:00.000Z' },
    };
    const result = formatBudget(b);
    expect(result).toContain('session');
  });

  it('handles 0% used', () => {
    expect(formatBudget({ session: { usedPct: 0 } })).toBe('session 0%');
  });

  it('handles 100% used', () => {
    expect(formatBudget({ weekly: { usedPct: 100 } })).toBe('weekly 100%');
  });

  it('session appears before weekly', () => {
    const b: UsageBudget = {
      session: { usedPct: 10 },
      weekly: { usedPct: 20 },
    };
    const parts = formatBudget(b).split(' · ');
    expect(parts[0]).toMatch(/^session/);
    expect(parts[1]).toMatch(/^weekly/);
  });
});

// ---------------------------------------------------------------------------
// USAGE_STALE_MS constant
// ---------------------------------------------------------------------------

describe('USAGE_STALE_MS', () => {
  it('equals 6 hours in milliseconds', () => {
    expect(USAGE_STALE_MS).toBe(6 * 60 * 60 * 1000);
  });
});
