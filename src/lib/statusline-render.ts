/**
 * Pure rendering for the `claude-profiles statusline` command.
 *
 * Claude Code invokes a configured `statusLine` command on every render and
 * passes a JSON object on stdin describing the session — including, for Pro/Max
 * subscribers, a `rate_limits` block with live 5-hour (session) and 7-day
 * (weekly) usage. That data is FREE: no API call, no token, no Keychain.
 *
 * Schema (the fields we use; all optional):
 *   {
 *     "model":      { "display_name": "Opus 4.8", "id": "claude-opus-4-8" },
 *     "workspace":  { "current_dir": "/…/proj", "project_dir": "/…/proj" },
 *     "rate_limits": {                 // only after the first API response
 *       "five_hour": { "used_percentage": 0-100, "resets_at": <unix secs> },
 *       "seven_day": { "used_percentage": 0-100, "resets_at": <unix secs> }
 *     }
 *   }
 *
 * The account this session runs under is the one thing Claude Code can't show
 * itself — we recover it from `CLAUDE_CONFIG_DIR` and lead the line with it.
 *
 * Everything here is pure and deterministic given a `now`; persistence and the
 * stdin read live in the command. No chalk import at module scope so callers can
 * opt out of color (NO_COLOR) — color is applied via an injected painter.
 */

import type { UsageBudget, UsageWindow } from '../types/index.js';
import type { CutoverInfo, UpNext } from './cutover.js';

// ──────────────────────────────────────────────────────────────────────────
// Input shape
// ──────────────────────────────────────────────────────────────────────────

export interface RateLimitWindow {
  used_percentage?: number;
  resets_at?: number;
}

export interface StatusLineInput {
  model?: { display_name?: string; id?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  gitBranch?: string;
  rate_limits?: {
    five_hour?: RateLimitWindow;
    seven_day?: RateLimitWindow;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Conversions
// ──────────────────────────────────────────────────────────────────────────

function isPct(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function epochToIso(secs: number | undefined): string | undefined {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return undefined;
  const ms = secs < 1e12 ? secs * 1000 : secs;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Map a statusLine `rate_limits` block to the shared {@link UsageBudget} so it
 * can be persisted and consumed by the routing strategies unchanged. Returns
 * undefined when no window carries a usable figure.
 */
export function budgetFromStatusLine(
  input: StatusLineInput,
  now: Date = new Date(),
): UsageBudget | undefined {
  const rl = input.rate_limits;
  if (!rl) return undefined;
  const observedAt = now.toISOString();

  function win(w: RateLimitWindow | undefined): UsageWindow | undefined {
    if (!w) return undefined;
    const window: UsageWindow = { observedAt, source: 'observed' };
    if (isPct(w.used_percentage)) {
      window.usedPct = Math.round(w.used_percentage);
    }
    const iso = epochToIso(w.resets_at);
    if (iso) window.resetAt = iso;
    if (window.usedPct == null && window.resetAt == null) return undefined;
    return window;
  }

  const session = win(rl.five_hour);
  const weekly = win(rl.seven_day);
  if (!session && !weekly) return undefined;

  const budget: UsageBudget = {};
  if (session) budget.session = session;
  if (weekly) budget.weekly = weekly;
  return budget;
}

// ──────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────

/** Severity bucket for a used-percentage, driving bar color. */
export type UsageLevel = 'ok' | 'warn' | 'crit';

export function usageLevel(usedPct: number): UsageLevel {
  if (usedPct >= 90) return 'crit';
  if (usedPct >= 70) return 'warn';
  return 'ok';
}

/** A fixed-width unicode meter: filled blocks for used, light for remaining. */
export function renderBar(usedPct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, usedPct));
  const filled = Math.round((clamped / 100) * width);
  return '▓'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** Compact "time until reset", e.g. `2h10m`, `45m`, `now`. */
export function formatResetIn(resetIso: string | undefined, now: Date): string | undefined {
  if (!resetIso) return undefined;
  const ms = Date.parse(resetIso) - now.getTime();
  if (Number.isNaN(ms)) return undefined;
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Painter abstraction so color can be disabled (NO_COLOR) without branching. */
export interface Painter {
  ok: (s: string) => string;
  warn: (s: string) => string;
  crit: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

/** A no-op painter (plain text). */
export const plainPainter: Painter = {
  ok: (s) => s,
  warn: (s) => s,
  crit: (s) => s,
  dim: (s) => s,
  bold: (s) => s,
};

function paintLevel(p: Painter, level: UsageLevel, s: string): string {
  return level === 'crit' ? p.crit(s) : level === 'warn' ? p.warn(s) : p.ok(s);
}

/** Render one window as `▓▓▓░░░░░░░ 32% · 2h10m`. */
export function renderWindow(
  label: string,
  window: UsageWindow | undefined,
  now: Date,
  p: Painter,
): string | undefined {
  if (!window || window.usedPct == null) return undefined;
  const pct = window.usedPct;
  const level = usageLevel(pct);
  const bar = paintLevel(p, level, renderBar(pct));
  const pctStr = paintLevel(p, level, `${pct}%`);
  const resetIn = formatResetIn(window.resetAt, now);
  const tail = resetIn ? ` ${p.dim('·')} ${p.dim(resetIn)}` : '';
  return `${p.dim(label)} ${bar} ${pctStr}${tail}`;
}

/** Compact minutes → `18m` / `2h10m` / `now`. */
export function formatMinutes(min: number | undefined): string | undefined {
  if (min == null || !Number.isFinite(min)) return undefined;
  if (min <= 0) return 'now';
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

/**
 * Render the cutover tail: the cap marker, the time/turns countdown, and who's
 * up next. Returns undefined when there is nothing to say (no cap in force).
 *
 *   `cap90 · ~18m/~6t → lockie`           (approaching)
 *   `⚠ OVER cap90 → lockie`               (over the cap, handoff staged)
 *   `cap95* · ~30m → lockie`              (* = pushed past the configured cap)
 */
export function renderCutover(
  cutover: CutoverInfo | undefined,
  upNext: UpNext | undefined,
  p: Painter,
): string | undefined {
  if (!cutover || cutover.capPct == null) return undefined;
  const nextName = upNext?.name ?? undefined;
  const arrow = nextName ? ` ${p.dim('→')} ${nextName}` : '';
  const star = cutover.overridden ? '*' : '';
  const capLabel = `cap${cutover.capPct}${star}`;

  if (cutover.overCap) {
    return p.crit(`⚠ OVER ${capLabel}`) + arrow;
  }

  const parts: string[] = [];
  const mins = formatMinutes(cutover.etaMin);
  if (mins) parts.push(`~${mins}`);
  if (cutover.etaTurns != null) parts.push(`~${cutover.etaTurns}t`);
  const eta = parts.length ? ` ${p.dim('·')} ${parts.join('/')}` : '';
  return `${p.dim(capLabel)}${eta}${arrow}`;
}

export interface RenderStatusLineOptions {
  account?: string;
  now?: Date;
  painter?: Painter;
  /** Show the 7-day window too (defaults to false — 5h is the headline). */
  showWeekly?: boolean;
  /** Cutover countdown to append after the session window. */
  cutover?: CutoverInfo;
  /** The account routing would move to next. */
  upNext?: UpNext;
}

/**
 * Render the full status line:
 *   `work │ ⎇ main │ Opus 4.8 │ proj │ 5h ▓▓▓░░░░░░░ 32% · 2h10m`
 *
 * Segments with no data are omitted. The rate bar is absent until Claude Code
 * populates `rate_limits` (early in a session) — by design, not an error.
 */
export function renderStatusLine(
  input: StatusLineInput,
  opts: RenderStatusLineOptions = {},
): string {
  const now = opts.now ?? new Date();
  const p = opts.painter ?? plainPainter;
  const segments: string[] = [];

  if (opts.account) segments.push(p.bold(opts.account));
  if (input.gitBranch) segments.push(`${p.dim('⎇')} ${input.gitBranch}`);
  if (input.model?.display_name) segments.push(input.model.display_name);

  const dir = input.workspace?.project_dir ?? input.workspace?.current_dir;
  if (dir) {
    const base = dir.replace(/\/+$/, '').split('/').pop();
    if (base) segments.push(p.dim(base));
  }

  const budget = budgetFromStatusLine(input, now);
  const session = renderWindow('5h', budget?.session, now, p);
  if (session) segments.push(session);

  const cutover = renderCutover(opts.cutover, opts.upNext, p);
  if (cutover) segments.push(cutover);

  if (opts.showWeekly) {
    const weekly = renderWindow('7d', budget?.weekly, now, p);
    if (weekly) segments.push(weekly);
  }

  return segments.join(` ${p.dim('│')} `);
}
