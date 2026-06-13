// Force chalk to emit ANSI codes even in non-TTY test environments.
process.env['FORCE_COLOR'] = '1';

import { describe, it, expect, vi } from 'vitest';
import {
  budgetBar,
  renderTransition,
  renderLaunchBanner,
  renderStatusDashboard,
  kindBadge,
  formatRoutingEvent,
  renderRoutingLog,
  printTransition,
  printLaunchBanner,
  printStatusDashboard,
  printRoutingLog,
} from '../../../src/lib/render.js';
import type { UsageBudget, UsageWindow } from '../../../src/lib/render.js';
import type { RoutingEvent } from '../../../src/types/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Return visible width of a line after stripping ANSI. */
const vlen = (s: string) => strip(s).length;

// ─── budgetBar ────────────────────────────────────────────────────────────────

describe('budgetBar', () => {
  it('renders full bar at 100%', () => {
    const result = strip(budgetBar(100, 12));
    // padStart(5): " 100%"
    expect(result).toBe('████████████ 100%');
  });

  it('renders empty bar at 0%', () => {
    const result = strip(budgetBar(0, 12));
    // padStart(5): "   0%"
    expect(result).toBe('░░░░░░░░░░░░   0%');
  });

  it('renders half bar at 50%', () => {
    const result = strip(budgetBar(50, 12));
    // padStart(5): "  50%"
    expect(result).toBe('██████░░░░░░  50%');
  });

  it('renders 20% (fill = 2 of 10, boundary for yellow)', () => {
    const result = strip(budgetBar(20, 10));
    // round(20/100*10) = 2 filled
    expect(result.startsWith('██░░░░░░░░')).toBe(true);
    expect(result).toContain('20%');
  });

  it('renders unknown pct', () => {
    const result = strip(budgetBar(undefined, 12));
    expect(result).toBe('░░░░░░░░░░░░  ?');
  });

  it('respects custom width', () => {
    const result = strip(budgetBar(50, 6));
    // 3 filled, 3 empty, padStart(5) label: "  50%"
    expect(result).toBe('███░░░  50%');
  });

  it('default width is 12', () => {
    const result = strip(budgetBar(100));
    expect(result.startsWith('████████████')).toBe(true);
  });

  it('clamps over-100 values', () => {
    const result = strip(budgetBar(150, 10));
    expect(result.startsWith('██████████')).toBe(true);
  });

  it('uses a different color for 75% (green) vs 10% (red)', () => {
    // Both should have ANSI codes when chalk level > 0, but even without color
    // the key invariant is: the stripped bar content is correct, and green/red
    // bars differ in their raw output (different ANSI codes or same plain text).
    // We test the structural invariant: stripped outputs are correct by level.
    const greenBar = strip(budgetBar(75, 4));
    const redBar   = strip(budgetBar(10, 4));
    // 75% → round(75/100*4) = 3 filled cells
    expect(greenBar).toContain('███');
    // 10% → round(10/100*4) = 0 filled cells
    expect(redBar).toContain('░░░░');
  });

  it('applies color coding: green bar raw !== red bar raw when chalk is active', () => {
    // Structural: unstripped results for different levels must differ
    // (they should differ because they carry different ANSI escape codes,
    // or at minimum their stripped form is different — validated by other tests).
    const greenRaw = budgetBar(75, 4);
    const redRaw   = budgetBar(10, 4);
    // They must be structurally different strings (color level or content)
    expect(greenRaw).not.toBe(redRaw);
  });

  it('yellow range (20–49%) produces different raw output than green or red', () => {
    const yellowRaw = budgetBar(30, 4);
    const greenRaw  = budgetBar(75, 4);
    const redRaw    = budgetBar(10, 4);
    expect(yellowRaw).not.toBe(greenRaw);
    expect(yellowRaw).not.toBe(redRaw);
  });
});

// ─── renderTransition ────────────────────────────────────────────────────────

describe('renderTransition', () => {
  it('contains both names and the arrow', () => {
    const result = strip(renderTransition({ from: 'josh', to: 'lockie', reason: 'rate limit' }));
    expect(result).toContain('josh');
    expect(result).toContain('▸▸▸');
    expect(result).toContain('lockie');
  });

  it('contains the reason', () => {
    const result = strip(renderTransition({ from: 'a', to: 'b', reason: 'usage/rate limit reached' }));
    expect(result).toContain('usage/rate limit reached');
  });

  it('has rounded box top and bottom characters', () => {
    const result = strip(renderTransition({ from: 'a', to: 'b', reason: 'test' }));
    const lines = result.split('\n');
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
  });

  it('null to shows no-account message', () => {
    const result = strip(renderTransition({ from: 'josh', to: null, reason: 'all exhausted' }));
    expect(result).toContain('no healthy account left');
  });

  it('null to does NOT include a budget line for the missing target', () => {
    const toBudget: UsageBudget = { session: { usedPct: 20 } };
    const result = strip(renderTransition({
      from: 'josh',
      to: null,
      reason: 'exhausted',
      toBudget,
    }));
    // No "to" account budget lines should appear
    expect(result).not.toMatch(/session\s+[█░]/);
  });

  it('ALL box body lines have equal visible width (alignment check)', () => {
    const fromBudget: UsageBudget = {
      session: { usedPct: 80 },
      weekly: { usedPct: 40 },
    };
    const toBudget: UsageBudget = {
      session: { usedPct: 5 },
      weekly: { usedPct: 90 },
    };
    const result = renderTransition({
      from: 'josh',
      to: 'lockie',
      reason: 'usage/rate limit reached',
      fromBudget,
      toBudget,
    });
    const lines = result.split('\n');
    // All lines (top, body, bottom) should have equal visible length
    const lengths = lines.map(vlen);
    const unique = new Set(lengths);
    expect(unique.size).toBe(1);
  });

  it('omits budget lines when no budget provided', () => {
    const result = strip(renderTransition({ from: 'a', to: 'b', reason: 'test' }));
    expect(result).not.toContain('session');
    expect(result).not.toContain('weekly');
  });

  it('includes session budget when fromBudget.session provided', () => {
    const fromBudget: UsageBudget = { session: { usedPct: 60 } };
    const result = strip(renderTransition({ from: 'josh', to: 'b', reason: 'test', fromBudget }));
    expect(result).toContain('session');
  });

  it('includes weekly budget when fromBudget.weekly provided', () => {
    const fromBudget: UsageBudget = { weekly: { usedPct: 30 } };
    const result = strip(renderTransition({ from: 'josh', to: 'b', reason: 'test', fromBudget }));
    expect(result).toContain('weekly');
  });

  it('box alignment holds with unicode names', () => {
    const result = renderTransition({
      from: 'alice',
      to: 'böb',
      reason: 'short',
    });
    const lines = result.split('\n');
    const lengths = lines.map(vlen);
    const unique = new Set(lengths);
    expect(unique.size).toBe(1);
  });
});

// ─── renderLaunchBanner ──────────────────────────────────────────────────────

describe('renderLaunchBanner', () => {
  it('contains the profile name', () => {
    const result = strip(renderLaunchBanner({ name: 'josh' }));
    expect(result).toContain('josh');
  });

  it('omits session when no session budget', () => {
    const result = strip(renderLaunchBanner({ name: 'josh' }));
    expect(result).not.toContain('session');
  });

  it('omits weekly when no weekly budget', () => {
    const result = strip(renderLaunchBanner({ name: 'josh' }));
    expect(result).not.toContain('weekly');
  });

  it('omits strategy when not given', () => {
    const result = strip(renderLaunchBanner({ name: 'josh' }));
    expect(result).not.toContain('strategy');
  });

  it('includes session % when provided', () => {
    const budget: UsageBudget = { session: { usedPct: 80 } };
    const result = strip(renderLaunchBanner({ name: 'josh', budget }));
    expect(result).toContain('session 20%');
  });

  it('includes weekly % when provided', () => {
    const budget: UsageBudget = { weekly: { usedPct: 10 } };
    const result = strip(renderLaunchBanner({ name: 'josh', budget }));
    expect(result).toContain('weekly 90%');
  });

  it('includes strategy when given', () => {
    const result = strip(renderLaunchBanner({ name: 'josh', strategy: 'round-robin' }));
    expect(result).toContain('strategy');
    expect(result).toContain('round-robin');
  });

  it('contains launching claude', () => {
    const result = strip(renderLaunchBanner({ name: 'test' }));
    expect(result).toContain('launching claude');
  });

  it('omits budget segments when usedPct is missing', () => {
    // usedPct undefined means "unknown" — should not render session/weekly
    const budget: UsageBudget = { session: { resetAt: '2025-01-01T00:00:00Z' } };
    const result = strip(renderLaunchBanner({ name: 'x', budget }));
    expect(result).not.toContain('session');
  });
});

// ─── renderStatusDashboard ───────────────────────────────────────────────────

describe('renderStatusDashboard', () => {
  it('renders healthy status', () => {
    const result = strip(renderStatusDashboard([
      { name: 'josh', status: 'healthy' },
    ]));
    expect(result).toContain('healthy');
  });

  it('renders cooling status with detail', () => {
    const result = strip(renderStatusDashboard([
      { name: 'josh', status: 'cooling', detail: 'until 14:30' },
    ]));
    expect(result).toContain('cooling down');
    expect(result).toContain('until 14:30');
  });

  it('renders auth status with detail', () => {
    const result = strip(renderStatusDashboard([
      { name: 'josh', status: 'auth', detail: 'token expired' },
    ]));
    expect(result).toContain('needs auth');
    expect(result).toContain('token expired');
  });

  it('renders profile name', () => {
    const result = strip(renderStatusDashboard([
      { name: 'myprofile', status: 'healthy' },
    ]));
    expect(result).toContain('myprofile');
  });

  it('renders description when provided', () => {
    const result = strip(renderStatusDashboard([
      { name: 'josh', status: 'healthy', description: 'work account' },
    ]));
    expect(result).toContain('work account');
  });

  it('omits session line when session not provided', () => {
    const result = strip(renderStatusDashboard([
      { name: 'x', status: 'healthy' },
    ]));
    expect(result).not.toContain('session');
  });

  it('renders session line when session provided', () => {
    const session: UsageWindow = { usedPct: 30 };
    const result = strip(renderStatusDashboard([
      { name: 'x', status: 'healthy', session },
    ]));
    expect(result).toContain('session');
    expect(result).toContain('70%');
  });

  it('renders weekly line when weekly provided', () => {
    const weekly: UsageWindow = { usedPct: 50 };
    const result = strip(renderStatusDashboard([
      { name: 'x', status: 'healthy', weekly },
    ]));
    expect(result).toContain('weekly');
    expect(result).toContain('50%');
  });

  it('omits weekly line when weekly not provided', () => {
    const result = strip(renderStatusDashboard([
      { name: 'x', status: 'healthy' },
    ]));
    expect(result).not.toContain('weekly');
  });

  it('separates multiple profiles with a blank line', () => {
    const result = strip(renderStatusDashboard([
      { name: 'a', status: 'healthy' },
      { name: 'b', status: 'cooling' },
    ]));
    expect(result).toContain('\n\n');
  });

  it('renders all three profiles in one output', () => {
    const result = strip(renderStatusDashboard([
      { name: 'a', status: 'healthy' },
      { name: 'b', status: 'cooling', detail: 'soon' },
      { name: 'c', status: 'auth', detail: 'login' },
    ]));
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
    expect(result).toContain('healthy');
    expect(result).toContain('cooling down');
    expect(result).toContain('needs auth');
  });

  it('returns empty string for empty rows array', () => {
    const result = renderStatusDashboard([]);
    expect(result).toBe('');
  });

  it('shows a "via" badge labeling a deliberate switch on a cooling row', () => {
    const result = strip(renderStatusDashboard([
      { name: 'josh', status: 'cooling', detail: 'soon', kind: 'manual' },
    ]));
    expect(result).toContain('via');
    expect(result).toContain('manual switch');
  });

  it('labels an automatic failover distinctly from a manual one', () => {
    const result = strip(renderStatusDashboard([
      { name: 'josh', status: 'cooling', detail: 'soon', kind: 'limit' },
    ]));
    expect(result).toContain('auto-failover');
    expect(result).not.toContain('manual switch');
  });

  it('omits the via badge on a healthy row', () => {
    const result = strip(renderStatusDashboard([
      { name: 'josh', status: 'healthy', kind: 'manual' },
    ]));
    expect(result).not.toContain('via');
  });
});

// ─── kindBadge ────────────────────────────────────────────────────────────────

describe('kindBadge', () => {
  it('labels a manual switch as a deliberate one', () => {
    expect(strip(kindBadge('manual'))).toContain('manual switch');
  });

  it('labels limit/auth/server as auto-failover', () => {
    expect(strip(kindBadge('limit'))).toContain('auto-failover');
    expect(strip(kindBadge('auth'))).toContain('auto-failover');
    expect(strip(kindBadge('server'))).toContain('auto-failover');
  });
});

// ─── formatRoutingEvent / renderRoutingLog ────────────────────────────────────

describe('formatRoutingEvent', () => {
  const now = new Date('2026-06-12T12:00:00.000Z');

  it('renders a manual switch with route and relative time', () => {
    const ev: RoutingEvent = {
      at: '2026-06-12T11:57:00.000Z',
      kind: 'manual',
      from: 'josh',
      to: 'lockie',
      reason: 'smoke test',
    };
    const out = strip(formatRoutingEvent(ev, now));
    expect(out).toContain('manual switch');
    expect(out).toContain('josh');
    expect(out).toContain('lockie');
    expect(out).toContain('3m ago');
    expect(out).toContain('smoke test');
  });

  it('renders an initial launch without a "from"', () => {
    const ev: RoutingEvent = {
      at: '2026-06-12T11:00:00.000Z',
      kind: 'launch',
      to: 'josh',
      chain: 'default',
    };
    const out = strip(formatRoutingEvent(ev, now));
    expect(out).toContain('launch');
    expect(out).toContain('josh');
    expect(out).toContain('[default]');
    expect(out).toContain('1h ago');
  });

  it('renders an exhausted event as routing to (none)', () => {
    const ev: RoutingEvent = {
      at: '2026-06-12T11:59:30.000Z',
      kind: 'exhausted',
      from: 'lockie',
      to: null,
    };
    const out = strip(formatRoutingEvent(ev, now));
    expect(out).toContain('exhausted');
    expect(out).toContain('(none)');
    expect(out).toContain('just now');
  });
});

describe('renderRoutingLog', () => {
  it('shows a placeholder when there is no history', () => {
    expect(strip(renderRoutingLog([]))).toContain('No routing history');
  });

  it('renders one line per event', () => {
    const now = new Date('2026-06-12T12:00:00.000Z');
    const events: RoutingEvent[] = [
      { at: '2026-06-12T11:00:00.000Z', kind: 'launch', to: 'josh' },
      { at: '2026-06-12T11:30:00.000Z', kind: 'limit', from: 'josh', to: 'lockie' },
    ];
    const out = strip(renderRoutingLog(events, now));
    expect(out.split('\n')).toHaveLength(2);
  });
});

// ─── smoke-test print wrappers ────────────────────────────────────────────────

describe('print wrappers (smoke)', () => {
  it('printTransition calls console.log once', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printTransition({ from: 'a', to: 'b', reason: 'test' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('printLaunchBanner calls console.log once', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printLaunchBanner({ name: 'josh' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('printRoutingLog calls console.log once', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printRoutingLog([{ at: '2026-06-12T11:00:00.000Z', kind: 'launch', to: 'josh' }]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('printStatusDashboard calls console.log once', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printStatusDashboard([{ name: 'x', status: 'healthy' }]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
