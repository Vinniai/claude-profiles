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

/** Compact "time until reset", e.g. `2h10m`, `45m`, `5d3h`, `now`. */
export function formatResetIn(resetIso: string | undefined, now: Date): string | undefined {
  if (!resetIso) return undefined;
  const ms = Date.parse(resetIso) - now.getTime();
  if (Number.isNaN(ms)) return undefined;
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  return h === 0 ? `${d}d` : `${d}d${h}h`;
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
 * Format the up-next account WITH its routing-relevant headroom:
 *   `lockie`                       (name only — nothing else known)
 *   `lockie 88%`                   (free session budget)
 *   `lockie 88% (wk 70% · fresh)`  (free session · weekly headroom · freshness)
 *
 * Freshness reads the next account's session window: a barely-used window is
 * `fresh` (you get a full run), otherwise we show when it resets so you know how
 * much of a window you'd be stepping into. Returns undefined with no target.
 */
export function upNextTarget(
  upNext: UpNext | undefined,
  now: Date,
  p: Painter,
): string | undefined {
  const name = upNext?.name ?? undefined;
  if (!name) return undefined;

  const free =
    upNext?.remainingPct != null ? ` ${p.bold(`${Math.round(upNext.remainingPct)}%`)}` : '';

  const detail: string[] = [];
  if (upNext?.weeklyRemainingPct != null) {
    detail.push(`wk ${Math.round(upNext.weeklyRemainingPct)}%`);
  }
  const used = upNext?.sessionUsedPct;
  if (used != null && used <= 15) {
    detail.push('fresh');
  } else if (upNext?.sessionResetAt) {
    const resetIn = formatResetIn(upNext.sessionResetAt, now);
    if (resetIn && resetIn !== 'now') detail.push(`resets ${resetIn}`);
  }
  const tail = detail.length ? ` ${p.dim(`(${detail.join(' · ')})`)}` : '';
  return `${name}${free}${tail}`;
}

/**
 * Render the cutover tail: the cap marker, the time/turns countdown, and who's
 * up next (with their headroom). Returns undefined when no cap is in force.
 *
 *   `cap90 · ~18m/~6t → lockie 88% (wk 70% · fresh)`   (approaching)
 *   `⚠ OVER cap90 → lockie 88% (wk 70%)`               (over the cap, staged)
 *   `cap95* · ~30m → lockie`                           (* = pushed past the cap)
 */
export function renderCutover(
  cutover: CutoverInfo | undefined,
  upNext: UpNext | undefined,
  p: Painter,
  now: Date = new Date(),
): string | undefined {
  if (!cutover || cutover.capPct == null) return undefined;
  const target = upNextTarget(upNext, now, p);
  const arrow = target ? ` ${p.dim('→')} ${target}` : '';
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

/**
 * The routing segment for the metrics line: the cutover countdown when a cap is
 * in force, else a bare `→ next` so the up-next account is always surfaced.
 */
export function renderRouting(
  cutover: CutoverInfo | undefined,
  upNext: UpNext | undefined,
  now: Date,
  p: Painter,
): string | undefined {
  const cut = renderCutover(cutover, upNext, p, now);
  if (cut) return cut;
  const target = upNextTarget(upNext, now, p);
  return target ? `${p.dim('→')} ${target}` : undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// Stacked banner — one row per account (current + up-next), 5h + 7d meters
// ──────────────────────────────────────────────────────────────────────────

/** Color bucket for a row's trailing note. */
export type NoteKind = 'switch' | 'cooldown' | 'next' | 'plain';

export interface AccountBannerRow {
  name: string;
  /** `current` is marked ▸ and bold; `next` carries the `↑ next` note. */
  marker: 'current' | 'next' | 'none';
  session?: UsageWindow;
  weekly?: UsageWindow;
  /** Trailing status, e.g. `switch ~1m` / `cooldown 2h` / `↑ next`. */
  note?: string;
  noteKind?: NoteKind;
}

function paintNote(p: Painter, kind: NoteKind | undefined, s: string): string {
  switch (kind) {
    case 'cooldown':
      return p.crit(s);
    case 'switch':
      return p.warn(s);
    case 'next':
      return p.dim(s);
    default:
      return s;
  }
}

/** `5h ▓▓▓░░░░░░░ 78%` — a labeled mini meter (no reset; the row stays compact). */
function bannerWindow(label: string, w: UsageWindow | undefined, p: Painter, barW: number): string {
  if (!w || w.usedPct == null) {
    return `${p.dim(label)} ${p.dim('░'.repeat(barW))} ${p.dim('  ?')}`;
  }
  const pct = w.usedPct;
  const level = usageLevel(pct);
  const bar = paintLevel(p, level, renderBar(pct, barW));
  const pctStr = paintLevel(p, level, `${pct}%`.padStart(4));
  return `${p.dim(label)} ${bar} ${pctStr}`;
}

/**
 * Render the stacked account banner:
 *
 *   Opus 4.8 · main
 *   ▸ josh    5h ▓▓▓▓▓▓▓▓░░ 78%  7d ▓▓░░░░░░░░ 22%   switch ~1m
 *     lockie  5h ░░░░░░░░░░  5%  7d ░░░░░░░░░░  4%   ↑ next
 *
 * The header is `model · branch` (no account / project term). Each account row
 * shows its 5-hour and 7-day windows as meters, with a trailing switchover ETA,
 * cooldown countdown, or `↑ next` marker. Newline-joined; empty when no rows.
 */
export function renderStackedBanner(opts: {
  header?: string;
  rows: AccountBannerRow[];
  painter?: Painter;
  barWidth?: number;
}): string {
  const p = opts.painter ?? plainPainter;
  const barW = opts.barWidth ?? 10;
  const rows = opts.rows;
  if (rows.length === 0) return opts.header ? p.dim(opts.header) : '';

  const nameW = Math.max(...rows.map((r) => r.name.length));
  const lines: string[] = [];
  if (opts.header) lines.push(p.dim(opts.header));

  for (const r of rows) {
    const isCurrent = r.marker === 'current';
    const prefix = isCurrent ? p.bold('▸') : ' ';
    const namePadded = r.name.padEnd(nameW);
    const name = isCurrent ? p.bold(namePadded) : namePadded;
    const sess = bannerWindow('5h', r.session, p, barW);
    const week = bannerWindow('7d', r.weekly, p, barW);
    const note = r.note ? `   ${paintNote(p, r.noteKind, r.note)}` : '';
    lines.push(`${prefix} ${name}  ${sess}  ${week}${note}`);
  }
  return lines.join('\n');
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
  /**
   * Two-line banner: a context line (account · model · branch · project) over a
   * metrics line (5h │ 7d │ routing). Surfaces the weekly window and the up-next
   * account's headroom that don't fit the compact single line.
   */
  twoLine?: boolean;
}

/**
 * Render the status line.
 *
 * One-line (default):
 *   `work │ ⎇ main │ Opus 4.8 │ proj │ 5h ▓▓▓░░░░░░░ 32% · 2h10m │ cap90 ~18m → lockie`
 *
 * Two-line (`twoLine: true`):
 *   `josh · Opus 4.8 · ⎇ main · proj`
 *   `5h ▓▓▓░ 32% · 2h10m │ 7d ▓▓ 22% · 5d │ cap90 · ~18m → lockie 88% (wk 70% · fresh)`
 *
 * Segments with no data are omitted. The rate bars are absent until Claude Code
 * populates `rate_limits` (early in a session) — by design, not an error.
 */
export function renderStatusLine(
  input: StatusLineInput,
  opts: RenderStatusLineOptions = {},
): string {
  const now = opts.now ?? new Date();
  const p = opts.painter ?? plainPainter;

  const account = opts.account ? p.bold(opts.account) : undefined;
  const branch = input.gitBranch ? `${p.dim('⎇')} ${input.gitBranch}` : undefined;
  const model = input.model?.display_name;
  const dir = input.workspace?.project_dir ?? input.workspace?.current_dir;
  const base = dir ? dir.replace(/\/+$/, '').split('/').pop() : undefined;
  const proj = base ? p.dim(base) : undefined;

  const budget = budgetFromStatusLine(input, now);
  const session = renderWindow('5h', budget?.session, now, p);
  const weekly = renderWindow('7d', budget?.weekly, now, p);

  if (opts.twoLine) {
    const bar = ` ${p.dim('│')} `;
    const context = [account, model, branch, proj]
      .filter((s): s is string => Boolean(s))
      .join(` ${p.dim('·')} `);
    const routing = renderRouting(opts.cutover, opts.upNext, now, p);
    const metrics = [session, weekly, routing]
      .filter((s): s is string => Boolean(s))
      .join(bar);
    return [context, metrics].filter((s) => s.length > 0).join('\n');
  }

  const segments: string[] = [];
  if (account) segments.push(account);
  if (branch) segments.push(branch);
  if (model) segments.push(model);
  if (proj) segments.push(proj);
  if (session) segments.push(session);

  const cutover = renderCutover(opts.cutover, opts.upNext, p, now);
  if (cutover) segments.push(cutover);

  if (opts.showWeekly && weekly) segments.push(weekly);

  return segments.join(` ${p.dim('│')} `);
}
