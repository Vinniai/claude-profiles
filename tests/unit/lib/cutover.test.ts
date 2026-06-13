import { describe, it, expect } from 'vitest';
import {
  baseCapPct,
  activeOverride,
  effectiveCapPct,
  effectiveMinSessionRemaining,
  updateBurnRate,
  computeCutover,
  computeDrain,
  computeSchedule,
  formatHour,
  resolveUpNext,
  decideAutoSwitch,
  DEFAULT_SESSION_CAP_PCT,
} from '../../../src/lib/cutover.js';
import type { RoutableCandidate } from '../../../src/lib/strategy.js';
import type { CapOverride, UsageWindow } from '../../../src/types/index.js';

const NOW = new Date('2026-06-13T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

describe('baseCapPct', () => {
  it('derives the cap from minSessionRemaining', () => {
    expect(baseCapPct({ minSessionRemaining: 10 })).toBe(90);
    expect(baseCapPct({ minSessionRemaining: 0 })).toBe(100);
  });
  it('is undefined when no session floor is configured', () => {
    expect(baseCapPct(undefined)).toBeUndefined();
    expect(baseCapPct({ minWeeklyRemaining: 20 })).toBeUndefined();
  });
});

describe('activeOverride', () => {
  const ov: CapOverride = { sessionCapPct: 95, until: iso(60 * 60_000) };
  it('returns a non-expired override', () => {
    expect(activeOverride(ov, NOW)).toBe(ov);
  });
  it('drops an expired override', () => {
    expect(activeOverride({ sessionCapPct: 95, until: iso(-1) }, NOW)).toBeUndefined();
  });
  it('keeps an override with no expiry', () => {
    expect(activeOverride({ sessionCapPct: 95 }, NOW)?.sessionCapPct).toBe(95);
  });
});

describe('effectiveCapPct / effectiveMinSessionRemaining', () => {
  it('override wins over the base cap while active', () => {
    const cap = effectiveCapPct({ minSessionRemaining: 10 }, { sessionCapPct: 95 }, NOW);
    expect(cap).toBe(95);
    expect(effectiveMinSessionRemaining({ minSessionRemaining: 10 }, { sessionCapPct: 95 }, NOW)).toBe(5);
  });
  it('falls back to the base cap when the override has expired', () => {
    const expired: CapOverride = { sessionCapPct: 95, until: iso(-1) };
    expect(effectiveCapPct({ minSessionRemaining: 10 }, expired, NOW)).toBe(90);
    expect(effectiveMinSessionRemaining({ minSessionRemaining: 10 }, expired, NOW)).toBe(10);
  });
  it('is undefined when neither base nor override sets a cap', () => {
    expect(effectiveCapPct(undefined, undefined, NOW)).toBeUndefined();
  });
});

describe('updateBurnRate', () => {
  const prev: UsageWindow = { usedPct: 30, observedAt: iso(-10 * 60_000) }; // 10m ago
  const cur: UsageWindow = { usedPct: 40, observedAt: iso(0) }; // now, +10% in 10m

  it('computes per-minute and per-turn from the first sample', () => {
    const b = updateBurnRate(prev, cur, undefined, NOW);
    expect(b!.sessionPctPerMin).toBeCloseTo(1, 5); // 10% / 10m
    expect(b!.pctPerTurn).toBe(10);
    expect(b!.at).toBe(NOW.toISOString());
  });
  it('EWMA-smooths against an existing estimate', () => {
    const b = updateBurnRate(prev, cur, { sessionPctPerMin: 3, pctPerTurn: 20 }, NOW);
    // alpha 0.5: 0.5*1 + 0.5*3 = 2 ; 0.5*10 + 0.5*20 = 15
    expect(b!.sessionPctPerMin).toBeCloseTo(2, 5);
    expect(b!.pctPerTurn).toBeCloseTo(15, 5);
  });
  it('ignores a window reset (usage dropped) and keeps the old per-minute estimate', () => {
    const reset: UsageWindow = { usedPct: 2, observedAt: iso(0) };
    const existing = { sessionPctPerMin: 1.5, pctPerTurn: 8 };
    const b = updateBurnRate(prev, reset, existing, NOW);
    expect(b!.sessionPctPerMin).toBe(1.5);
    expect(b!.pctPerTurn).toBe(8);
    expect(b!.anchorPct).toBe(2); // re-anchored at the post-reset level
  });
  it('seeds an anchor (no rate yet) when the previous percentage is unknown', () => {
    const b = updateBurnRate({ observedAt: iso(-60_000) }, cur, undefined, NOW);
    expect(b!.sessionPctPerMin).toBeUndefined();
    expect(b!.anchorPct).toBe(40);
  });
  it('ignores a sub-threshold time delta (rapid re-render jitter) for per-minute', () => {
    // Two observations 20ms apart with a real usage jump — would explode without
    // the anchor floor. Per-minute must be skipped; per-turn still records it.
    const a: UsageWindow = { usedPct: 30, observedAt: iso(-20) };
    const b: UsageWindow = { usedPct: 60, observedAt: iso(0) };
    const burn = updateBurnRate(a, b, undefined, NOW);
    expect(burn!.sessionPctPerMin).toBeUndefined();
    expect(burn!.pctPerTurn).toBe(30);
    expect(burn!.anchorPct).toBe(30); // anchor stays at the seed, awaiting time
  });
  it('holds the anchor across rapid renders, then samples once a real window elapses', () => {
    // Render 1: seed anchor at 40% (no prior burn).
    const r1 = updateBurnRate(undefined, { usedPct: 40, observedAt: iso(0) }, undefined, NOW);
    expect(r1!.sessionPctPerMin).toBeUndefined();
    expect(r1!.anchorPct).toBe(40);
    // Render 2: 5s later, usage ticked to 41% — sub-minute, anchor must hold.
    const r2 = updateBurnRate(
      { usedPct: 40, observedAt: iso(0) },
      { usedPct: 41, observedAt: iso(5_000) },
      r1,
      new Date(NOW.getTime() + 5_000),
    );
    expect(r2!.sessionPctPerMin).toBeUndefined();
    expect(r2!.anchorPct).toBe(40); // still anchored at the original 40%/t0
    // Render 3: 2 minutes from the anchor, now at 46% → 6% over 2m = 3%/min.
    const r3 = updateBurnRate(
      { usedPct: 41, observedAt: iso(5_000) },
      { usedPct: 46, observedAt: iso(120_000) },
      r2,
      new Date(NOW.getTime() + 120_000),
    );
    expect(r3!.sessionPctPerMin).toBeCloseTo(3, 5);
    expect(r3!.anchorPct).toBe(46); // anchor advanced after the sample
  });
});

describe('computeCutover', () => {
  it('reports headroom + ETA below the cap', () => {
    const c = computeCutover({
      session: { usedPct: 78 },
      policy: { minSessionRemaining: 10 }, // cap 90
      burn: { sessionPctPerMin: 0.667, pctPerTurn: 2 },
      now: NOW,
    });
    expect(c.capPct).toBe(90);
    expect(c.usedPct).toBe(78);
    expect(c.remainingPct).toBe(12);
    expect(c.overCap).toBe(false);
    expect(c.etaMin).toBe(18); // 12 / 0.667 ≈ 18
    expect(c.etaTurns).toBe(6); // 12 / 2
    expect(c.overridden).toBe(false);
  });
  it('flags over-cap and omits ETA', () => {
    const c = computeCutover({
      session: { usedPct: 94 },
      policy: { minSessionRemaining: 10 },
      burn: { sessionPctPerMin: 1 },
      now: NOW,
    });
    expect(c.overCap).toBe(true);
    expect(c.etaMin).toBeUndefined();
  });
  it('respects an active push override (raised cap, overridden flag)', () => {
    const c = computeCutover({
      session: { usedPct: 92 },
      policy: { minSessionRemaining: 10 }, // base cap 90
      override: { sessionCapPct: 95, until: iso(60 * 60_000) },
      now: NOW,
    });
    expect(c.capPct).toBe(95);
    expect(c.overCap).toBe(false); // 92 < 95
    expect(c.overridden).toBe(true);
  });
  it('has no cap (and never over-cap) when no policy floor or override', () => {
    const c = computeCutover({ session: { usedPct: 99 }, now: NOW });
    expect(c.capPct).toBeUndefined();
    expect(c.overCap).toBe(false);
  });
});

describe('computeDrain', () => {
  const policy = { preferIfWindowEndsWithinMin: 30, minWeeklyRemaining: 25 };
  const weeklyHealthy: UsageWindow = { usedPct: 3 }; // 97% remaining
  const weeklyLow: UsageWindow = { usedPct: 80 }; // 20% remaining

  it('is undefined when no drain rule (preferIfWindowEndsWithinMin) is set', () => {
    expect(computeDrain({ policy: { minWeeklyRemaining: 25 }, now: NOW })).toBeUndefined();
    expect(computeDrain({ now: NOW })).toBeUndefined();
  });

  it('is ACTIVE when the window is within the threshold and weekly is healthy', () => {
    const d = computeDrain({
      session: { usedPct: 33, resetAt: iso(20 * 60_000) }, // resets in 20m
      weekly: weeklyHealthy,
      policy,
      now: NOW,
    });
    expect(d!.state).toBe('active');
    expect(d!.preferWithinMin).toBe(30);
    expect(d!.weeklyFloorPct).toBe(25);
    expect(Math.round(d!.windowEndsInMin!)).toBe(20);
  });

  it('is IDLE when eligible but the window is still far from resetting', () => {
    const d = computeDrain({
      session: { usedPct: 33, resetAt: iso(4 * 3600_000) }, // resets in 4h
      weekly: weeklyHealthy,
      policy,
      now: NOW,
    });
    expect(d!.state).toBe('idle');
  });

  it('is CONSERVING when weekly is at/below the floor, even if the window is close', () => {
    const d = computeDrain({
      session: { usedPct: 33, resetAt: iso(10 * 60_000) }, // resets in 10m
      weekly: weeklyLow, // 20% < 25%
      policy,
      now: NOW,
    });
    expect(d!.state).toBe('conserving');
    expect(d!.weeklyRemainingPct).toBe(20);
  });

  it('treats unknown weekly as passing the floor gate', () => {
    const d = computeDrain({
      session: { usedPct: 33, resetAt: iso(10 * 60_000) },
      weekly: undefined,
      policy,
      now: NOW,
    });
    expect(d!.state).toBe('active');
  });
});

describe('formatHour', () => {
  it('renders a 12-hour clock label', () => {
    expect(formatHour(0)).toBe('12am');
    expect(formatHour(1)).toBe('1am');
    expect(formatHour(12)).toBe('12pm');
    expect(formatHour(13)).toBe('1pm');
    expect(formatHour(21)).toBe('9pm');
    expect(formatHour(23)).toBe('11pm');
  });
});

describe('computeSchedule', () => {
  // Local-time constructor so the hour is deterministic regardless of TZ.
  const at = (hour: number) => new Date(2026, 5, 13, hour, 0, 0);

  it('is undefined when no preferHours rule is set', () => {
    expect(computeSchedule({ policy: {}, now: at(22) })).toBeUndefined();
    expect(computeSchedule({ now: at(22) })).toBeUndefined();
  });

  it('is ACTIVE inside a midnight-wrapping window (9pm–1am)', () => {
    const policy = { preferHours: { start: 21, end: 1 } };
    expect(computeSchedule({ policy, now: at(22) })!.state).toBe('active');
    expect(computeSchedule({ policy, now: at(0) })!.state).toBe('active');
    expect(computeSchedule({ policy, now: at(21) })!.state).toBe('active');
  });

  it('is IDLE outside a midnight-wrapping window', () => {
    const policy = { preferHours: { start: 21, end: 1 } };
    expect(computeSchedule({ policy, now: at(1) })!.state).toBe('idle'); // end is exclusive
    expect(computeSchedule({ policy, now: at(12) })!.state).toBe('idle');
    expect(computeSchedule({ policy, now: at(20) })!.state).toBe('idle');
  });

  it('handles a same-day window (9am–5pm)', () => {
    const policy = { preferHours: { start: 9, end: 17 } };
    expect(computeSchedule({ policy, now: at(9) })!.state).toBe('active');
    expect(computeSchedule({ policy, now: at(16) })!.state).toBe('active');
    expect(computeSchedule({ policy, now: at(17) })!.state).toBe('idle'); // exclusive end
    expect(computeSchedule({ policy, now: at(8) })!.state).toBe('idle');
  });

  it('echoes the configured window back for display', () => {
    const s = computeSchedule({ policy: { preferHours: { start: 21, end: 1 } }, now: at(22) });
    expect(s!.hours).toEqual({ start: 21, end: 1 });
    expect(s!.withinWindow).toBe(true);
  });
});

describe('resolveUpNext', () => {
  const mk = (
    name: string,
    priorityIndex: number,
    usedPct: number,
    extra: Partial<RoutableCandidate> = {},
  ): RoutableCandidate => ({
    name,
    healthy: true,
    priorityIndex,
    usage: { session: { usedPct } },
    ...extra,
  });

  it('returns the next account after the current one (priority order)', () => {
    const next = resolveUpNext(
      [mk('josh', 0, 50), mk('lockie', 1, 10), mk('trev', 2, 5)],
      'josh',
      'priority',
      NOW,
    );
    expect(next.name).toBe('lockie');
    expect(next.remainingPct).toBe(90);
  });

  it('demotes an over-cap candidate so the next healthy account wins', () => {
    // josh is current and over its cap → lockie next; trev gated below floor.
    const candidates = [
      mk('josh', 0, 95, { policy: { minSessionRemaining: 10 } }),
      mk('lockie', 1, 20, { policy: { minSessionRemaining: 10 } }),
      mk('trev', 2, 96, { policy: { minSessionRemaining: 10 } }),
    ];
    const next = resolveUpNext(candidates, 'josh', 'most-remaining', NOW);
    expect(next.name).toBe('lockie');
  });

  it('returns null when only the current account exists', () => {
    expect(resolveUpNext([mk('josh', 0, 10)], 'josh', 'priority', NOW).name).toBeNull();
  });
});

describe('decideAutoSwitch', () => {
  // Local-time clock so `preferHours` (schedule rule) is timezone-independent.
  const atLocal = (hour: number) => new Date(2026, 5, 13, hour, 0, 0);
  // A fixed "midday" local time well outside any schedule window we test.
  const MID = atLocal(12);

  const mk = (
    name: string,
    priorityIndex: number,
    extra: Partial<RoutableCandidate> = {},
  ): RoutableCandidate => ({
    name,
    healthy: true,
    priorityIndex,
    usage: { session: { usedPct: 10 } },
    ...extra,
  });

  it('returns undefined when the current account is not among the candidates', () => {
    expect(
      decideAutoSwitch({ candidates: [mk('lockie', 0)], current: 'josh', now: MID }),
    ).toBeUndefined();
  });

  it('stays put on pure strategy ordering — no rule fires', () => {
    // round-robin would order lockie first, but no over-cap/schedule/drain rule
    // applies, so we do NOT yank the session off a healthy, eligible account.
    const candidates = [
      mk('josh', 0, { lastUsedAt: '2026-06-13T11:59:00.000Z' }),
      mk('lockie', 1, { lastUsedAt: '2026-06-13T08:00:00.000Z' }),
    ];
    expect(
      decideAutoSwitch({ candidates, current: 'josh', strategy: 'round-robin', now: MID }),
    ).toBeUndefined();
  });

  it('switches off an over-cap current account to the next eligible one', () => {
    const candidates = [
      mk('josh', 0, {
        usage: { session: { usedPct: 95 } },
        policy: { minSessionRemaining: 10 },
      }),
      mk('lockie', 1, {
        usage: { session: { usedPct: 20 } },
        policy: { minSessionRemaining: 10 },
      }),
    ];
    const d = decideAutoSwitch({ candidates, current: 'josh', now: MID });
    expect(d?.to).toBe('lockie');
    expect(d?.kind).toBe('policy');
    expect(d?.reason).toContain('cap90');
  });

  it('switches when the target enters its preferred hours (schedule rule)', () => {
    const candidates = [
      mk('josh', 0),
      mk('lockie', 1, { policy: { preferHours: { start: 21, end: 1 } } }),
    ];
    // 22:00 local is inside lockie's 9pm–1am window; josh has no rule.
    const d = decideAutoSwitch({ candidates, current: 'josh', now: atLocal(22) });
    expect(d?.to).toBe('lockie');
    expect(d?.reason).toContain('preferred hours');
  });

  it('does not switch outside the target preferred window', () => {
    const candidates = [
      mk('josh', 0),
      mk('lockie', 1, { policy: { preferHours: { start: 21, end: 1 } } }),
    ];
    expect(
      decideAutoSwitch({ candidates, current: 'josh', now: atLocal(12) }),
    ).toBeUndefined();
  });

  it('switches when the target session is about to reset (drain rule)', () => {
    const candidates = [
      mk('josh', 0),
      mk('lockie', 1, {
        usage: { session: { usedPct: 20, resetAt: iso(5 * 60_000) } },
        policy: { preferIfWindowEndsWithinMin: 30 },
      }),
    ];
    const d = decideAutoSwitch({ candidates, current: 'josh', now: NOW });
    expect(d?.to).toBe('lockie');
    expect(d?.reason).toContain('about to reset');
  });

  it('does not switch when the current account is itself preferred', () => {
    // Both inside their schedule windows → current stays; don't bounce off a
    // rule that still favours where we are.
    const candidates = [
      mk('josh', 0, { policy: { preferHours: { start: 21, end: 1 } } }),
      mk('lockie', 1, { policy: { preferHours: { start: 21, end: 1 } } }),
    ];
    expect(
      decideAutoSwitch({ candidates, current: 'josh', now: atLocal(23) }),
    ).toBeUndefined();
  });

  it('does not switch to an unhealthy or ineligible target', () => {
    // lockie is preferred by schedule but cooling down; trev is over its floor.
    const candidates = [
      mk('josh', 0),
      mk('lockie', 1, {
        healthy: false,
        policy: { preferHours: { start: 21, end: 1 } },
      }),
    ];
    expect(
      decideAutoSwitch({ candidates, current: 'josh', now: atLocal(22) }),
    ).toBeUndefined();
  });
});

describe('constants', () => {
  it('defaults the session cap to 90%', () => {
    expect(DEFAULT_SESSION_CAP_PCT).toBe(90);
  });
});
