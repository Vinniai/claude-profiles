import { describe, it, expect } from 'vitest';
import {
  computeSessionPace,
  computeWeeklyPace,
  computeAccountPace,
  buildResetTimeline,
  formatSpan,
  WEEKLY_WINDOW_MIN,
} from '../../../src/lib/pace.js';
import type { UsageWindow } from '../../../src/types/index.js';

const now = new Date('2026-06-13T12:00:00.000Z');

/** A UsageWindow that resets `min` minutes from `now`. */
function win(usedPct: number, minFromNow: number): UsageWindow {
  return {
    usedPct,
    resetAt: new Date(now.getTime() + minFromNow * 60_000).toISOString(),
  } as UsageWindow;
}

describe('computeSessionPace', () => {
  it('is unknown without a used percent', () => {
    expect(computeSessionPace({ now }).verdict).toBe('unknown');
  });

  it('is capped when used is at/over the cap', () => {
    const p = computeSessionPace({ session: win(95, 60), capPct: 90, now });
    expect(p.verdict).toBe('capped');
    expect(p.remainingPct).toBe(0);
  });

  it('is idle with headroom but no measured burn', () => {
    const p = computeSessionPace({ session: win(20, 120), capPct: 90, now });
    expect(p.verdict).toBe('idle');
    expect(p.idealPctPerMin).toBeCloseTo(70 / 120, 5);
  });

  it('reports on-pace when actual ≈ ideal', () => {
    // headroom 70 over 120m → ideal ≈ 0.583%/m
    const p = computeSessionPace({
      session: win(20, 120),
      capPct: 90,
      burnPctPerMin: 70 / 120,
      now,
    });
    expect(p.verdict).toBe('on-pace');
    expect(p.ratio).toBeCloseTo(1, 5);
  });

  it('flags too-fast when burning above ideal', () => {
    const p = computeSessionPace({
      session: win(20, 120),
      capPct: 90,
      burnPctPerMin: 2.0, // ideal ≈ 0.58
      now,
    });
    expect(p.verdict).toBe('too-fast');
    expect(p.exhaustInMin).toBeLessThan(p.resetInMin ?? Infinity);
  });

  it('flags underusing when burning below ideal', () => {
    const p = computeSessionPace({
      session: win(20, 120),
      capPct: 90,
      burnPctPerMin: 0.1, // ideal ≈ 0.58
      now,
    });
    expect(p.verdict).toBe('underusing');
    expect(p.leftoverPct ?? 0).toBeGreaterThan(0);
  });
});

describe('computeWeeklyPace', () => {
  it('is underusing when well under the linear line', () => {
    // Halfway through the week (resets in half the window) but only 10% used.
    const p = computeWeeklyPace({
      weekly: win(10, WEEKLY_WINDOW_MIN / 2),
      now,
    });
    expect(p.verdict).toBe('underusing');
    expect(p.leftoverPct ?? 0).toBeGreaterThan(0); // positive slack
  });

  it('is too-fast when well ahead of the line', () => {
    const p = computeWeeklyPace({
      weekly: win(90, WEEKLY_WINDOW_MIN / 2),
      now,
    });
    expect(p.verdict).toBe('too-fast');
    expect(p.leftoverPct ?? 0).toBeLessThan(0);
  });

  it('is on-pace when tracking the line', () => {
    const p = computeWeeklyPace({
      weekly: win(50, WEEKLY_WINDOW_MIN / 2),
      now,
    });
    expect(p.verdict).toBe('on-pace');
  });

  it('is capped at 100% used', () => {
    expect(computeWeeklyPace({ weekly: win(100, 1000), now }).verdict).toBe('capped');
  });
});

describe('computeAccountPace binding', () => {
  it('binds to the window that exhausts before its reset, soonest', () => {
    // Session: fast burn, exhausts well before its 120m reset.
    const acct = computeAccountPace({
      name: 'a',
      session: win(20, 120),
      weekly: win(10, WEEKLY_WINDOW_MIN / 2),
      capPct: 90,
      burnPctPerMin: 5,
      now,
    });
    expect(acct.binding).toBe('session');
  });

  it('has no binding when neither window will exhaust before reset', () => {
    const acct = computeAccountPace({
      name: 'a',
      session: win(20, 120),
      weekly: win(10, WEEKLY_WINDOW_MIN / 2),
      capPct: 90,
      burnPctPerMin: 0.01,
      now,
    });
    expect(acct.binding).toBeUndefined();
  });
});

describe('buildResetTimeline', () => {
  it('places the furthest reset at the right edge and nearer ones proportionally', () => {
    const geo = buildResetTimeline({
      accounts: [
        { name: 'josh', session: win(50, 130), weekly: win(40, 7200) },
        { name: 'lockie', session: win(10, 35) },
      ],
      now,
      width: 40,
    });
    expect(geo.horizonMin).toBe(7200);
    const josh = geo.rows.find((r) => r.name === 'josh')!;
    const weekly = josh.markers.find((m) => m.kind === 'weekly')!;
    expect(weekly.col).toBe(39); // furthest → right edge
    const lockie = geo.rows.find((r) => r.name === 'lockie')!;
    const sess = lockie.markers.find((m) => m.kind === 'session')!;
    expect(sess.col).toBeGreaterThanOrEqual(0);
    expect(sess.col).toBeLessThan(weekly.col);
  });

  it('omits markers for windows without a reset', () => {
    const geo = buildResetTimeline({
      accounts: [{ name: 'x' }],
      now,
      width: 20,
    });
    expect(geo.rows[0].markers).toHaveLength(0);
  });
});

describe('formatSpan', () => {
  it('formats spans compactly', () => {
    expect(formatSpan(0)).toBe('now');
    expect(formatSpan(35)).toBe('35m');
    expect(formatSpan(130)).toBe('2h10m');
    expect(formatSpan(120)).toBe('2h');
    expect(formatSpan(7300)).toBe('5d1h');
    expect(formatSpan(undefined)).toBe('?');
  });
});
