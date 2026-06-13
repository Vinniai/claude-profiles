import { describe, it, expect } from 'vitest';
import {
  evaluateEligibility,
  applyStrategy,
  applyPreferenceBoost,
  applyRouting,
  resolveStrategy,
  isWithinPreferredHours,
  isPreferenceBoosted,
  type RoutableCandidate,
} from '../../../src/lib/strategy.js';
import type { UsageBudget } from '../../../src/types/index.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2024-06-01T12:00:00.000Z');
const NOW_MS = NOW.getTime();

function minCandidate(
  overrides: Partial<RoutableCandidate> = {},
): RoutableCandidate {
  return {
    name: 'profile-a',
    healthy: true,
    priorityIndex: 0,
    ...overrides,
  };
}

/** Build a UsageBudget with a session resetAt N minutes in the future. */
function budgetResetsInMin(min: number, usedPct?: number): UsageBudget {
  return {
    session: {
      usedPct,
      resetAt: new Date(NOW_MS + min * 60_000).toISOString(),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. evaluateEligibility
// ──────────────────────────────────────────────────────────────────────────────

describe('evaluateEligibility', () => {
  it('passes with no policy', () => {
    const c = minCandidate({ policy: undefined });
    const r = evaluateEligibility(c, NOW);
    expect(r.eligible).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('passes with empty policy', () => {
    const c = minCandidate({ policy: {} });
    const r = evaluateEligibility(c, NOW);
    expect(r.eligible).toBe(true);
  });

  // ── minWeeklyRemaining ──────────────────────────────────────────────────────

  it('minWeeklyRemaining: passes when remaining >= threshold', () => {
    const c = minCandidate({
      policy: { minWeeklyRemaining: 20 },
      usage: { weekly: { usedPct: 70 } }, // 30% remaining >= 20%
    });
    expect(evaluateEligibility(c, NOW).eligible).toBe(true);
  });

  it('minWeeklyRemaining: fails when remaining < threshold', () => {
    const c = minCandidate({
      policy: { minWeeklyRemaining: 50 },
      usage: { weekly: { usedPct: 85 } }, // 15% remaining < 50%
    });
    const r = evaluateEligibility(c, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/weekly budget 15%/);
    expect(r.reasons[0]).toMatch(/50% required/);
  });

  it('minWeeklyRemaining: passes (unknown = pass) when usedPct missing', () => {
    const c = minCandidate({
      policy: { minWeeklyRemaining: 50 },
      usage: { weekly: { resetAt: '2099-01-01T00:00:00Z' } }, // no usedPct
    });
    expect(evaluateEligibility(c, NOW).eligible).toBe(true);
  });

  it('minWeeklyRemaining: passes when usage is entirely undefined', () => {
    const c = minCandidate({
      policy: { minWeeklyRemaining: 50 },
      usage: undefined,
    });
    expect(evaluateEligibility(c, NOW).eligible).toBe(true);
  });

  // ── minSessionRemaining ─────────────────────────────────────────────────────

  it('minSessionRemaining: passes when remaining >= threshold', () => {
    const c = minCandidate({
      policy: { minSessionRemaining: 30 },
      usage: { session: { usedPct: 60 } }, // 40% >= 30%
    });
    expect(evaluateEligibility(c, NOW).eligible).toBe(true);
  });

  it('minSessionRemaining: fails when remaining < threshold', () => {
    const c = minCandidate({
      policy: { minSessionRemaining: 30 },
      usage: { session: { usedPct: 90 } }, // 10% < 30%
    });
    const r = evaluateEligibility(c, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/session budget 10%/);
    expect(r.reasons[0]).toMatch(/30% required/);
  });

  it('minSessionRemaining: passes when session usedPct unknown', () => {
    const c = minCandidate({
      policy: { minSessionRemaining: 30 },
      usage: { session: {} },
    });
    expect(evaluateEligibility(c, NOW).eligible).toBe(true);
  });

  // ── avoidIfWindowEndsWithinMin ──────────────────────────────────────────────

  it('avoidIfWindowEndsWithinMin: passes when window ends far in the future', () => {
    const c = minCandidate({
      policy: { avoidIfWindowEndsWithinMin: 10 },
      usage: budgetResetsInMin(30), // 30 min away, avoid < 10
    });
    expect(evaluateEligibility(c, NOW).eligible).toBe(true);
  });

  it('avoidIfWindowEndsWithinMin: fails when window ends within threshold', () => {
    const c = minCandidate({
      policy: { avoidIfWindowEndsWithinMin: 10 },
      usage: budgetResetsInMin(8), // 8 min away <= 10
    });
    const r = evaluateEligibility(c, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/session window resets in/);
    expect(r.reasons[0]).toMatch(/avoid < 10m/);
  });

  it('avoidIfWindowEndsWithinMin: passes when resetAt unknown', () => {
    const c = minCandidate({
      policy: { avoidIfWindowEndsWithinMin: 10 },
      usage: { session: { usedPct: 50 } }, // no resetAt
    });
    expect(evaluateEligibility(c, NOW).eligible).toBe(true);
  });

  // ── multiple reasons ────────────────────────────────────────────────────────

  it('accumulates multiple reasons', () => {
    const c = minCandidate({
      policy: { minWeeklyRemaining: 50, minSessionRemaining: 50 },
      usage: {
        weekly: { usedPct: 90 },   // 10% < 50%
        session: { usedPct: 80 },  // 20% < 50%
      },
    });
    const r = evaluateEligibility(c, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. applyStrategy
// ──────────────────────────────────────────────────────────────────────────────

describe('applyStrategy', () => {
  // ── priority ────────────────────────────────────────────────────────────────
  it('priority: sorts ascending by priorityIndex', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 2 });
    const b = minCandidate({ name: 'b', priorityIndex: 0 });
    const c = minCandidate({ name: 'c', priorityIndex: 1 });
    const result = applyStrategy('priority', [a, b, c], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('priority: does not mutate the input array', () => {
    const candidates = [
      minCandidate({ name: 'a', priorityIndex: 1 }),
      minCandidate({ name: 'b', priorityIndex: 0 }),
    ];
    const original = [...candidates];
    applyStrategy('priority', candidates, NOW);
    expect(candidates[0].name).toBe(original[0].name);
    expect(candidates[1].name).toBe(original[1].name);
  });

  // ── round-robin ─────────────────────────────────────────────────────────────
  it('round-robin: never-used (undefined lastUsedAt) sorts first', () => {
    const used = minCandidate({
      name: 'used',
      priorityIndex: 0,
      lastUsedAt: '2024-06-01T10:00:00.000Z',
    });
    const fresh = minCandidate({
      name: 'fresh',
      priorityIndex: 1,
      lastUsedAt: undefined,
    });
    const result = applyStrategy('round-robin', [used, fresh], NOW);
    expect(result.map(x => x.name)).toEqual(['fresh', 'used']);
  });

  it('round-robin: oldest last-used comes first', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0, lastUsedAt: '2024-06-01T11:00:00.000Z' });
    const b = minCandidate({ name: 'b', priorityIndex: 1, lastUsedAt: '2024-06-01T09:00:00.000Z' });
    const c = minCandidate({ name: 'c', priorityIndex: 2, lastUsedAt: '2024-06-01T10:00:00.000Z' });
    const result = applyStrategy('round-robin', [a, b, c], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('round-robin: tie-breaks by priorityIndex', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 2, lastUsedAt: undefined });
    const b = minCandidate({ name: 'b', priorityIndex: 0, lastUsedAt: undefined });
    const result = applyStrategy('round-robin', [a, b], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'a']);
  });

  // ── least-used ──────────────────────────────────────────────────────────────
  it('least-used: sorts by session usedPct ascending', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0, usage: { session: { usedPct: 80 } } });
    const b = minCandidate({ name: 'b', priorityIndex: 1, usage: { session: { usedPct: 20 } } });
    const c = minCandidate({ name: 'c', priorityIndex: 2, usage: { session: { usedPct: 50 } } });
    const result = applyStrategy('least-used', [a, b, c], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('least-used: unknown usedPct treated as 0 (sorts first)', () => {
    const known = minCandidate({ name: 'known', priorityIndex: 1, usage: { session: { usedPct: 5 } } });
    const unknown = minCandidate({ name: 'unknown', priorityIndex: 0, usage: undefined });
    const result = applyStrategy('least-used', [known, unknown], NOW);
    // unknown treated as 0 usedPct, so same as known 5% — tie on index wins
    // actually 0 < 5, so unknown first regardless of index
    expect(result[0].name).toBe('unknown');
  });

  it('least-used: tie-breaks by priorityIndex', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 1, usage: { session: { usedPct: 40 } } });
    const b = minCandidate({ name: 'b', priorityIndex: 0, usage: { session: { usedPct: 40 } } });
    const result = applyStrategy('least-used', [a, b], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'a']);
  });

  // ── most-remaining ──────────────────────────────────────────────────────────
  it('most-remaining: highest remaining first', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0, usage: { session: { usedPct: 80 } } }); // 20%
    const b = minCandidate({ name: 'b', priorityIndex: 1, usage: { session: { usedPct: 10 } } }); // 90%
    const c = minCandidate({ name: 'c', priorityIndex: 2, usage: { session: { usedPct: 50 } } }); // 50%
    const result = applyStrategy('most-remaining', [a, b, c], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('most-remaining: unknown usedPct treated as 100% remaining (sorts first)', () => {
    const known = minCandidate({ name: 'known', priorityIndex: 0, usage: { session: { usedPct: 5 } } }); // 95%
    const unknown = minCandidate({ name: 'unknown', priorityIndex: 1, usage: undefined }); // 100%
    const result = applyStrategy('most-remaining', [known, unknown], NOW);
    expect(result[0].name).toBe('unknown');
  });

  it('most-remaining: window-ends-furthest wins on tie', () => {
    // Both have 50% remaining, but different resetAt
    const futureReset = new Date(NOW_MS + 60 * 60_000).toISOString(); // 60 min
    const nearReset = new Date(NOW_MS + 10 * 60_000).toISOString();   // 10 min
    const a = minCandidate({
      name: 'a',
      priorityIndex: 0,
      usage: { session: { usedPct: 50, resetAt: nearReset } },
    });
    const b = minCandidate({
      name: 'b',
      priorityIndex: 1,
      usage: { session: { usedPct: 50, resetAt: futureReset } },
    });
    const result = applyStrategy('most-remaining', [a, b], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'a']);
  });

  // ── weighted ────────────────────────────────────────────────────────────────
  it('weighted: deterministic with injected rand returning sequence', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0, weight: 1 });
    const b = minCandidate({ name: 'b', priorityIndex: 1, weight: 3 });
    const c = minCandidate({ name: 'c', priorityIndex: 2, weight: 1 });

    // total = 5; simulate rand values that deterministically pick b, then c, then a
    // Round 1: total=5, pick = rand()*5; value 0.5 → 2.5 > 1 (a), then 2.5-3=-.5 <=0 → b picked (idx 1)
    // Round 2: remaining [a(1), c(1)], total=2, pick = rand()*2; value 0.9 → 1.8 > 1 (a), then 1.8-1=0.8 > 0 (c), end → idx=1=c
    // Round 3: only a left → a
    const vals = [0.5, 0.9, 0.5];
    let i = 0;
    const fakeRand = () => vals[i++]!;

    const result = applyStrategy('weighted', [a, b, c], NOW, fakeRand);
    expect(result.map(x => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('weighted: non-positive weight still appears in output (epsilon)', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0, weight: 0 });
    const b = minCandidate({ name: 'b', priorityIndex: 1, weight: 5 });
    const result = applyStrategy('weighted', [a, b], NOW, () => 0);
    expect(result).toHaveLength(2);
    expect(result.map(x => x.name)).toContain('a');
    expect(result.map(x => x.name)).toContain('b');
  });

  it('weighted: does not mutate the input array', () => {
    const candidates = [
      minCandidate({ name: 'a', priorityIndex: 0, weight: 1 }),
      minCandidate({ name: 'b', priorityIndex: 1, weight: 2 }),
    ];
    const originalNames = candidates.map(c => c.name);
    applyStrategy('weighted', candidates, NOW, () => 0);
    expect(candidates.map(c => c.name)).toEqual(originalNames);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. applyPreferenceBoost
// ──────────────────────────────────────────────────────────────────────────────

describe('applyPreferenceBoost', () => {
  it('boosts a candidate whose session window ends within the threshold', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0, policy: undefined });
    const b = minCandidate({
      name: 'b',
      priorityIndex: 1,
      policy: { preferIfWindowEndsWithinMin: 15 },
      usage: budgetResetsInMin(5), // 5 min <= 15
    });
    const c = minCandidate({ name: 'c', priorityIndex: 2 });

    const result = applyPreferenceBoost([a, b, c], NOW);
    expect(result.map(x => x.name)).toEqual(['b', 'a', 'c']);
  });

  it('does NOT boost a candidate whose window ends beyond the threshold', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0 });
    const b = minCandidate({
      name: 'b',
      priorityIndex: 1,
      policy: { preferIfWindowEndsWithinMin: 15 },
      usage: budgetResetsInMin(30), // 30 min > 15
    });

    const result = applyPreferenceBoost([a, b], NOW);
    expect(result.map(x => x.name)).toEqual(['a', 'b']); // unchanged
  });

  it('does NOT boost a candidate with preferIf but no resetAt', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0 });
    const b = minCandidate({
      name: 'b',
      priorityIndex: 1,
      policy: { preferIfWindowEndsWithinMin: 15 },
      usage: { session: { usedPct: 50 } }, // no resetAt
    });

    const result = applyPreferenceBoost([a, b], NOW);
    expect(result.map(x => x.name)).toEqual(['a', 'b']);
  });

  it('preserves relative order among multiple boosted candidates', () => {
    const a = minCandidate({
      name: 'a',
      priorityIndex: 0,
      policy: { preferIfWindowEndsWithinMin: 20 },
      usage: budgetResetsInMin(10),
    });
    const b = minCandidate({ name: 'b', priorityIndex: 1 });
    const c = minCandidate({
      name: 'c',
      priorityIndex: 2,
      policy: { preferIfWindowEndsWithinMin: 20 },
      usage: budgetResetsInMin(5),
    });
    const d = minCandidate({ name: 'd', priorityIndex: 3 });

    const result = applyPreferenceBoost([a, b, c, d], NOW);
    // a and c are boosted (relative order a, c preserved); then b, d
    expect(result.map(x => x.name)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('does not mutate input', () => {
    const candidates = [
      minCandidate({ name: 'a', priorityIndex: 0 }),
      minCandidate({
        name: 'b',
        priorityIndex: 1,
        policy: { preferIfWindowEndsWithinMin: 20 },
        usage: budgetResetsInMin(5),
      }),
    ];
    const before = candidates.map(c => c.name);
    applyPreferenceBoost(candidates, NOW);
    expect(candidates.map(c => c.name)).toEqual(before);
  });

  // Local-time constructor so the hour is deterministic regardless of TZ.
  const atLocal = (hour: number) => new Date(2026, 5, 13, hour, 0, 0);

  it('boosts a candidate inside its preferHours window', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0 });
    const b = minCandidate({
      name: 'b',
      priorityIndex: 1,
      policy: { preferHours: { start: 21, end: 1 } },
    });
    const result = applyPreferenceBoost([a, b], atLocal(22)); // 10pm → inside
    expect(result.map(x => x.name)).toEqual(['b', 'a']);
  });

  it('does NOT boost a preferHours candidate outside the window', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 0 });
    const b = minCandidate({
      name: 'b',
      priorityIndex: 1,
      policy: { preferHours: { start: 21, end: 1 } },
    });
    const result = applyPreferenceBoost([a, b], atLocal(12)); // noon → outside
    expect(result.map(x => x.name)).toEqual(['a', 'b']);
  });
});

describe('isWithinPreferredHours', () => {
  const atLocal = (hour: number) => new Date(2026, 5, 13, hour, 0, 0);

  it('returns false for no window', () => {
    expect(isWithinPreferredHours(undefined, atLocal(22))).toBe(false);
  });

  it('matches a midnight-wrapping window half-open at the end', () => {
    const w = { start: 21, end: 1 };
    expect(isWithinPreferredHours(w, atLocal(21))).toBe(true);
    expect(isWithinPreferredHours(w, atLocal(0))).toBe(true);
    expect(isWithinPreferredHours(w, atLocal(1))).toBe(false); // end exclusive
    expect(isWithinPreferredHours(w, atLocal(20))).toBe(false);
  });

  it('matches a same-day window half-open at the end', () => {
    const w = { start: 9, end: 17 };
    expect(isWithinPreferredHours(w, atLocal(9))).toBe(true);
    expect(isWithinPreferredHours(w, atLocal(16))).toBe(true);
    expect(isWithinPreferredHours(w, atLocal(17))).toBe(false);
  });

  it('never matches a degenerate start === end window', () => {
    expect(isWithinPreferredHours({ start: 9, end: 9 }, atLocal(9))).toBe(false);
  });
});

describe('isPreferenceBoosted', () => {
  const atLocal = (hour: number) => new Date(2026, 5, 13, hour, 0, 0);

  it('is false with no preference rules', () => {
    expect(isPreferenceBoosted(minCandidate(), atLocal(22))).toBe(false);
  });

  it('is true inside a preferHours window (schedule rule)', () => {
    const c = minCandidate({ policy: { preferHours: { start: 21, end: 1 } } });
    expect(isPreferenceBoosted(c, atLocal(22))).toBe(true);
    expect(isPreferenceBoosted(c, atLocal(12))).toBe(false);
  });

  it('is true when the session window resets within the drain threshold', () => {
    const soon = new Date(atLocal(12).getTime() + 5 * 60_000).toISOString();
    const c = minCandidate({
      usage: { session: { usedPct: 20, resetAt: soon } },
      policy: { preferIfWindowEndsWithinMin: 30 },
    });
    expect(isPreferenceBoosted(c, atLocal(12))).toBe(true);
  });

  it('is false when the window reset is beyond the drain threshold', () => {
    const later = new Date(atLocal(12).getTime() + 90 * 60_000).toISOString();
    const c = minCandidate({
      usage: { session: { usedPct: 20, resetAt: later } },
      policy: { preferIfWindowEndsWithinMin: 30 },
    });
    expect(isPreferenceBoosted(c, atLocal(12))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. applyRouting
// ──────────────────────────────────────────────────────────────────────────────

describe('applyRouting', () => {
  it('never drops anyone — ineligible appear last', () => {
    const eligible = minCandidate({ name: 'e', priorityIndex: 0, healthy: true });
    const ineligible = minCandidate({
      name: 'i',
      priorityIndex: 1,
      healthy: true,
      policy: { minSessionRemaining: 80 },
      usage: { session: { usedPct: 90 } }, // 10% < 80%
    });

    const { ordered } = applyRouting({ candidates: [eligible, ineligible], now: NOW });
    expect(ordered).toHaveLength(2);
    expect(ordered.map(x => x.name)).toContain('i');
    expect(ordered[ordered.length - 1].name).toBe('i');
  });

  it('eligible+healthy appear before eligible+unhealthy', () => {
    const healthy = minCandidate({ name: 'healthy', priorityIndex: 0, healthy: true });
    const unhealthy = minCandidate({ name: 'unhealthy', priorityIndex: 1, healthy: false });

    const { ordered } = applyRouting({ candidates: [unhealthy, healthy], now: NOW });
    expect(ordered[0].name).toBe('healthy');
    expect(ordered[1].name).toBe('unhealthy');
  });

  it('eligible+unhealthy appear before ineligible', () => {
    const unhealthy = minCandidate({ name: 'unhealthy', priorityIndex: 0, healthy: false });
    const ineligible = minCandidate({
      name: 'ineligible',
      priorityIndex: 1,
      healthy: true,
      policy: { minSessionRemaining: 80 },
      usage: { session: { usedPct: 90 } },
    });

    const { ordered } = applyRouting({ candidates: [ineligible, unhealthy], now: NOW });
    expect(ordered[0].name).toBe('unhealthy');
    expect(ordered[1].name).toBe('ineligible');
  });

  it('deferred populated with ineligible names and reasons', () => {
    const ineligible = minCandidate({
      name: 'strained',
      priorityIndex: 0,
      healthy: true,
      policy: { minWeeklyRemaining: 50 },
      usage: { weekly: { usedPct: 90 } },
    });

    const { deferred } = applyRouting({ candidates: [ineligible], now: NOW });
    expect(deferred).toHaveLength(1);
    expect(deferred[0].name).toBe('strained');
    expect(deferred[0].reasons[0]).toMatch(/weekly budget/);
  });

  it('eligible candidates have empty deferred array', () => {
    const c = minCandidate({ name: 'ok', priorityIndex: 0, healthy: true });
    const { deferred } = applyRouting({ candidates: [c], now: NOW });
    expect(deferred).toHaveLength(0);
  });

  it('applies strategy to healthy+eligible candidates', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 2, healthy: true, lastUsedAt: '2024-06-01T11:00:00Z' });
    const b = minCandidate({ name: 'b', priorityIndex: 0, healthy: true, lastUsedAt: '2024-06-01T09:00:00Z' });
    // b was least-recently used → round-robin puts b first
    const { ordered } = applyRouting({ candidates: [a, b], strategy: 'round-robin', now: NOW });
    expect(ordered[0].name).toBe('b');
    expect(ordered[1].name).toBe('a');
  });

  it('applies preference boost within healthy+eligible group', () => {
    const normal = minCandidate({ name: 'normal', priorityIndex: 0, healthy: true });
    const preferred = minCandidate({
      name: 'preferred',
      priorityIndex: 1,
      healthy: true,
      policy: { preferIfWindowEndsWithinMin: 15 },
      usage: budgetResetsInMin(5),
    });

    const { ordered } = applyRouting({ candidates: [normal, preferred], now: NOW });
    expect(ordered[0].name).toBe('preferred');
    expect(ordered[1].name).toBe('normal');
  });

  it('full pipeline: healthy + unhealthy + ineligible all present', () => {
    const healthy = minCandidate({ name: 'healthy', priorityIndex: 0, healthy: true });
    const unhealthy = minCandidate({ name: 'unhealthy', priorityIndex: 1, healthy: false });
    const ineligible = minCandidate({
      name: 'ineligible',
      priorityIndex: 2,
      healthy: true,
      policy: { minSessionRemaining: 80 },
      usage: { session: { usedPct: 90 } },
    });

    const { ordered, deferred } = applyRouting({
      candidates: [ineligible, unhealthy, healthy],
      now: NOW,
    });

    expect(ordered).toHaveLength(3);
    expect(ordered.map(x => x.name)).toEqual(['healthy', 'unhealthy', 'ineligible']);
    expect(deferred).toHaveLength(1);
    expect(deferred[0].name).toBe('ineligible');
  });

  it('ineligible group is sorted by priorityIndex', () => {
    const i2 = minCandidate({
      name: 'i2',
      priorityIndex: 2,
      healthy: true,
      policy: { minSessionRemaining: 80 },
      usage: { session: { usedPct: 90 } },
    });
    const i0 = minCandidate({
      name: 'i0',
      priorityIndex: 0,
      healthy: true,
      policy: { minSessionRemaining: 80 },
      usage: { session: { usedPct: 90 } },
    });

    const { ordered } = applyRouting({ candidates: [i2, i0], now: NOW });
    // Both ineligible — sorted by priorityIndex: i0 then i2
    expect(ordered.map(x => x.name)).toEqual(['i0', 'i2']);
  });

  it('default strategy is priority when none provided', () => {
    const a = minCandidate({ name: 'a', priorityIndex: 1, healthy: true });
    const b = minCandidate({ name: 'b', priorityIndex: 0, healthy: true });

    const { ordered } = applyRouting({ candidates: [a, b], now: NOW });
    expect(ordered.map(x => x.name)).toEqual(['b', 'a']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. resolveStrategy
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveStrategy', () => {
  it('defaults to priority with no config', () => {
    const r = resolveStrategy();
    expect(r.strategy).toBe('priority');
    expect(r.policy).toBeUndefined();
  });

  it('uses global strategy when no perChain', () => {
    const r = resolveStrategy({ strategy: 'round-robin' });
    expect(r.strategy).toBe('round-robin');
  });

  it('perChain strategy overrides global', () => {
    const r = resolveStrategy({ strategy: 'round-robin' }, { strategy: 'weighted' });
    expect(r.strategy).toBe('weighted');
  });

  it('perChain strategy overrides global; global strategy used if perChain has none', () => {
    const r = resolveStrategy({ strategy: 'least-used' }, { policy: { minSessionRemaining: 20 } });
    expect(r.strategy).toBe('least-used');
  });

  it('policy: global policy used when no perChain policy', () => {
    const r = resolveStrategy({ policy: { minWeeklyRemaining: 30 } });
    expect(r.policy).toEqual({ minWeeklyRemaining: 30 });
  });

  it('policy: perChain fields win over global', () => {
    const r = resolveStrategy(
      { policy: { minWeeklyRemaining: 30, minSessionRemaining: 20 } },
      { policy: { minSessionRemaining: 50 } }, // perChain overrides session
    );
    expect(r.policy).toEqual({ minWeeklyRemaining: 30, minSessionRemaining: 50 });
  });

  it('policy: perChain adds new fields not in global', () => {
    const r = resolveStrategy(
      { policy: { minWeeklyRemaining: 30 } },
      { policy: { avoidIfWindowEndsWithinMin: 5 } },
    );
    expect(r.policy).toEqual({
      minWeeklyRemaining: 30,
      avoidIfWindowEndsWithinMin: 5,
    });
  });

  it('policy is undefined when neither config has a policy', () => {
    const r = resolveStrategy({ strategy: 'priority' }, { strategy: 'weighted' });
    expect(r.policy).toBeUndefined();
  });

  it('all fields from perChain policy overwrite global', () => {
    const r = resolveStrategy(
      {
        strategy: 'priority',
        policy: {
          minWeeklyRemaining: 10,
          minSessionRemaining: 10,
          avoidIfWindowEndsWithinMin: 10,
          preferIfWindowEndsWithinMin: 10,
        },
      },
      {
        strategy: 'round-robin',
        policy: {
          minWeeklyRemaining: 99,
          minSessionRemaining: 99,
          avoidIfWindowEndsWithinMin: 99,
          preferIfWindowEndsWithinMin: 99,
        },
      },
    );
    expect(r.strategy).toBe('round-robin');
    expect(r.policy).toEqual({
      minWeeklyRemaining: 99,
      minSessionRemaining: 99,
      avoidIfWindowEndsWithinMin: 99,
      preferIfWindowEndsWithinMin: 99,
    });
  });
});
