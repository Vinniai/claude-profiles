import { describe, it, expect } from 'vitest';
import {
  renderBar,
  usageLevel,
  formatResetIn,
  formatMinutes,
  budgetFromStatusLine,
  renderWindow,
  renderCutover,
  renderStatusLine,
  plainPainter,
  type StatusLineInput,
} from '../../../src/lib/statusline-render.js';
import type { CutoverInfo, UpNext } from '../../../src/lib/cutover.js';

const NOW = new Date('2026-06-13T12:00:00.000Z');
const RESET_5H = Math.floor(NOW.getTime() / 1000) + 2 * 3600 + 10 * 60; // +2h10m
const RESET_7D = Math.floor(NOW.getTime() / 1000) + 3 * 24 * 3600;

describe('renderBar', () => {
  it('fills proportionally to a 10-wide meter', () => {
    expect(renderBar(0)).toBe('░░░░░░░░░░');
    expect(renderBar(100)).toBe('▓▓▓▓▓▓▓▓▓▓');
    expect(renderBar(32)).toBe('▓▓▓░░░░░░░');
    expect(renderBar(94)).toBe('▓▓▓▓▓▓▓▓▓░');
  });
  it('clamps out-of-range input', () => {
    expect(renderBar(-5)).toBe('░░░░░░░░░░');
    expect(renderBar(150)).toBe('▓▓▓▓▓▓▓▓▓▓');
  });
});

describe('usageLevel', () => {
  it('buckets ok / warn / crit', () => {
    expect(usageLevel(10)).toBe('ok');
    expect(usageLevel(69)).toBe('ok');
    expect(usageLevel(70)).toBe('warn');
    expect(usageLevel(89)).toBe('warn');
    expect(usageLevel(90)).toBe('crit');
  });
});

describe('formatResetIn', () => {
  it('renders compact durations', () => {
    expect(formatResetIn(new Date(NOW.getTime() + 130 * 60_000).toISOString(), NOW)).toBe('2h10m');
    expect(formatResetIn(new Date(NOW.getTime() + 45 * 60_000).toISOString(), NOW)).toBe('45m');
    expect(formatResetIn(new Date(NOW.getTime() + 120 * 60_000).toISOString(), NOW)).toBe('2h');
    expect(formatResetIn(new Date(NOW.getTime() - 60_000).toISOString(), NOW)).toBe('now');
    expect(formatResetIn(undefined, NOW)).toBeUndefined();
  });
});

describe('budgetFromStatusLine', () => {
  it('maps five_hour/seven_day to session/weekly windows', () => {
    const input: StatusLineInput = {
      rate_limits: {
        five_hour: { used_percentage: 32, resets_at: RESET_5H },
        seven_day: { used_percentage: 10, resets_at: RESET_7D },
      },
    };
    const b = budgetFromStatusLine(input, NOW);
    expect(b!.session?.usedPct).toBe(32);
    expect(b!.weekly?.usedPct).toBe(10);
    expect(b!.session?.resetAt).toBe(new Date(RESET_5H * 1000).toISOString());
    expect(b!.session?.source).toBe('observed');
  });
  it('returns undefined when rate_limits absent (early session)', () => {
    expect(budgetFromStatusLine({}, NOW)).toBeUndefined();
    expect(budgetFromStatusLine({ rate_limits: {} }, NOW)).toBeUndefined();
  });
  it('keeps a window that has only a reset', () => {
    const b = budgetFromStatusLine({ rate_limits: { five_hour: { resets_at: RESET_5H } } }, NOW);
    expect(b!.session?.usedPct).toBeUndefined();
    expect(b!.session?.resetAt).toBeDefined();
  });
});

describe('renderWindow', () => {
  it('renders bar + pct + reset', () => {
    const out = renderWindow(
      '5h',
      { usedPct: 32, resetAt: new Date(NOW.getTime() + 130 * 60_000).toISOString() },
      NOW,
      plainPainter,
    );
    expect(out).toBe('5h ▓▓▓░░░░░░░ 32% · 2h10m');
  });
  it('omits a window with no usedPct', () => {
    expect(renderWindow('5h', { resetAt: undefined }, NOW, plainPainter)).toBeUndefined();
    expect(renderWindow('5h', undefined, NOW, plainPainter)).toBeUndefined();
  });
});

describe('formatMinutes', () => {
  it('renders compact durations', () => {
    expect(formatMinutes(18)).toBe('18m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(130)).toBe('2h10m');
    expect(formatMinutes(0)).toBe('now');
    expect(formatMinutes(undefined)).toBeUndefined();
  });
});

describe('renderCutover', () => {
  const next: UpNext = { name: 'lockie', remainingPct: 88 };
  it('renders cap + eta + up-next when approaching', () => {
    const c: CutoverInfo = {
      capPct: 90, usedPct: 78, remainingPct: 12, overCap: false,
      etaMin: 18, etaTurns: 6, overridden: false,
    };
    expect(renderCutover(c, next, plainPainter)).toBe('cap90 · ~18m/~6t → lockie');
  });
  it('marks a pushed cap with a star', () => {
    const c: CutoverInfo = {
      capPct: 95, usedPct: 80, remainingPct: 15, overCap: false,
      etaMin: 30, overridden: true,
    };
    expect(renderCutover(c, next, plainPainter)).toBe('cap95* · ~30m → lockie');
  });
  it('shows an OVER warning past the cap', () => {
    const c: CutoverInfo = { capPct: 90, usedPct: 94, remainingPct: -4, overCap: true, overridden: false };
    expect(renderCutover(c, next, plainPainter)).toBe('⚠ OVER cap90 → lockie');
  });
  it('returns undefined when no cap is in force', () => {
    expect(renderCutover({ overCap: false, overridden: false }, next, plainPainter)).toBeUndefined();
    expect(renderCutover(undefined, next, plainPainter)).toBeUndefined();
  });
});

describe('renderStatusLine', () => {
  it('assembles account │ branch │ model │ project │ 5h bar', () => {
    const input: StatusLineInput = {
      model: { display_name: 'Opus 4.8' },
      workspace: { project_dir: '/Users/x/code/claude-profiles' },
      gitBranch: 'main',
      rate_limits: { five_hour: { used_percentage: 32, resets_at: RESET_5H } },
    };
    const out = renderStatusLine(input, { account: 'work', now: NOW, painter: plainPainter });
    expect(out).toBe('work │ ⎇ main │ Opus 4.8 │ claude-profiles │ 5h ▓▓▓░░░░░░░ 32% · 2h10m');
  });

  it('omits the rate bar before Claude Code populates rate_limits', () => {
    const out = renderStatusLine(
      { model: { display_name: 'Sonnet 4.6' }, gitBranch: 'dev' },
      { account: 'lockie', now: NOW, painter: plainPainter },
    );
    expect(out).toBe('lockie │ ⎇ dev │ Sonnet 4.6');
  });

  it('adds the 7d window only when showWeekly is set', () => {
    const input: StatusLineInput = {
      rate_limits: {
        five_hour: { used_percentage: 32, resets_at: RESET_5H },
        seven_day: { used_percentage: 10, resets_at: RESET_7D },
      },
    };
    const withWeek = renderStatusLine(input, {
      account: 'work', now: NOW, painter: plainPainter, showWeekly: true,
    });
    expect(withWeek).toContain('7d ▓░░░░░░░░░ 10%');
    const withoutWeek = renderStatusLine(input, { account: 'work', now: NOW, painter: plainPainter });
    expect(withoutWeek).not.toContain('7d');
  });
});
