import { describe, it, expect } from 'vitest';
import {
  renderBar,
  usageLevel,
  formatResetIn,
  formatMinutes,
  budgetFromStatusLine,
  renderWindow,
  renderCutover,
  renderRouting,
  upNextTarget,
  renderStatusLine,
  renderStackedBanner,
  plainPainter,
  type StatusLineInput,
  type AccountBannerRow,
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
  const bare: UpNext = { name: 'lockie' };
  it('renders cap + eta + up-next free budget when approaching', () => {
    const c: CutoverInfo = {
      capPct: 90, usedPct: 78, remainingPct: 12, overCap: false,
      etaMin: 18, etaTurns: 6, overridden: false,
    };
    expect(renderCutover(c, next, plainPainter, NOW)).toBe('cap90 · ~18m/~6t → lockie 88%');
  });
  it('shows just the name when no headroom is known', () => {
    const c: CutoverInfo = {
      capPct: 90, usedPct: 78, remainingPct: 12, overCap: false,
      etaMin: 18, etaTurns: 6, overridden: false,
    };
    expect(renderCutover(c, bare, plainPainter, NOW)).toBe('cap90 · ~18m/~6t → lockie');
  });
  it('marks a pushed cap with a star', () => {
    const c: CutoverInfo = {
      capPct: 95, usedPct: 80, remainingPct: 15, overCap: false,
      etaMin: 30, overridden: true,
    };
    expect(renderCutover(c, next, plainPainter, NOW)).toBe('cap95* · ~30m → lockie 88%');
  });
  it('shows an OVER warning past the cap', () => {
    const c: CutoverInfo = { capPct: 90, usedPct: 94, remainingPct: -4, overCap: true, overridden: false };
    expect(renderCutover(c, next, plainPainter, NOW)).toBe('⚠ OVER cap90 → lockie 88%');
  });
  it('returns undefined when no cap is in force', () => {
    expect(renderCutover({ overCap: false, overridden: false }, next, plainPainter, NOW)).toBeUndefined();
    expect(renderCutover(undefined, next, plainPainter, NOW)).toBeUndefined();
  });
});

describe('upNextTarget', () => {
  it('appends free budget, weekly headroom and freshness', () => {
    const up: UpNext = {
      name: 'lockie', remainingPct: 88, weeklyRemainingPct: 70, sessionUsedPct: 5,
    };
    expect(upNextTarget(up, NOW, plainPainter)).toBe('lockie 88% (wk 70% · fresh)');
  });
  it('shows the next window reset when the account is not fresh', () => {
    const up: UpNext = {
      name: 'lockie', remainingPct: 40, weeklyRemainingPct: 60,
      sessionUsedPct: 60, sessionResetAt: new Date(NOW.getTime() + 3 * 3600_000).toISOString(),
    };
    expect(upNextTarget(up, NOW, plainPainter)).toBe('lockie 40% (wk 60% · resets 3h)');
  });
  it('is just the name with no extra data', () => {
    expect(upNextTarget({ name: 'lockie' }, NOW, plainPainter)).toBe('lockie');
  });
  it('is undefined with no target', () => {
    expect(upNextTarget({ name: null }, NOW, plainPainter)).toBeUndefined();
    expect(upNextTarget(undefined, NOW, plainPainter)).toBeUndefined();
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

  it('renders a two-line banner: context over metrics with weekly + up-next', () => {
    const input: StatusLineInput = {
      model: { display_name: 'Opus 4.8' },
      workspace: { project_dir: '/Users/x/code/claude-profiles' },
      gitBranch: 'main',
      rate_limits: {
        five_hour: { used_percentage: 32, resets_at: RESET_5H },
        seven_day: { used_percentage: 22, resets_at: RESET_7D },
      },
    };
    const out = renderStatusLine(input, {
      account: 'josh',
      now: NOW,
      painter: plainPainter,
      twoLine: true,
      cutover: { capPct: 90, usedPct: 32, remainingPct: 58, overCap: false, etaMin: 18, overridden: false },
      upNext: { name: 'lockie', remainingPct: 88, weeklyRemainingPct: 70, sessionUsedPct: 4 },
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('josh · Opus 4.8 · ⎇ main · claude-profiles');
    expect(lines[1]).toContain('5h ▓▓▓░░░░░░░ 32% · 2h10m');
    expect(lines[1]).toContain('7d ▓▓░░░░░░░░ 22% · 3d');
    expect(lines[1]).toContain('→ lockie 88% (wk 70% · fresh)');
  });
});

describe('renderRouting', () => {
  it('falls back to a bare arrow when no cap is in force', () => {
    const out = renderRouting(undefined, { name: 'lockie', remainingPct: 88 }, NOW, plainPainter);
    expect(out).toBe('→ lockie 88%');
  });
  it('is undefined with neither cap nor target', () => {
    expect(renderRouting(undefined, { name: null }, NOW, plainPainter)).toBeUndefined();
  });
});

describe('renderStackedBanner', () => {
  const rows: AccountBannerRow[] = [
    {
      name: 'josh',
      marker: 'current',
      session: { usedPct: 78, resetAt: new Date(NOW.getTime() + 130 * 60_000).toISOString() },
      weekly: { usedPct: 22 },
      note: 'switch ~1m',
      noteKind: 'switch',
    },
    {
      name: 'lockie',
      marker: 'next',
      session: { usedPct: 5 },
      weekly: { usedPct: 4 },
      note: '↑ next',
      noteKind: 'next',
    },
  ];

  it('stacks header + one row per account with aligned names and meters', () => {
    const out = renderStackedBanner({ header: 'Opus 4.8 · ⎇ main', rows, painter: plainPainter });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Opus 4.8 · ⎇ main');
    expect(lines[1]).toBe('▸ josh    5h ▓▓▓▓▓▓▓▓░░  78%  7d ▓▓░░░░░░░░  22%   switch ~1m');
    expect(lines[2]).toBe('  lockie  5h ▓░░░░░░░░░   5%  7d ░░░░░░░░░░   4%   ↑ next');
  });

  it('marks unknown windows with a ?', () => {
    const out = renderStackedBanner({
      rows: [{ name: 'work', marker: 'current', session: undefined, weekly: undefined }],
      painter: plainPainter,
    });
    expect(out).toContain('5h ░░░░░░░░░░   ?');
    expect(out).toContain('7d ░░░░░░░░░░   ?');
  });

  it('is just the header (or empty) with no rows', () => {
    expect(renderStackedBanner({ header: 'Opus 4.8', rows: [], painter: plainPainter })).toBe('Opus 4.8');
    expect(renderStackedBanner({ rows: [], painter: plainPainter })).toBe('');
  });
});
