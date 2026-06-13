/**
 * Pure "pace" math + reset-timeline geometry for claude-profiles.
 *
 * Turns each account's usage windows (session + weekly) into an efficiency
 * read-out: are you burning a window FAST enough to use it before it resets
 * (avoiding wasted, unspent budget) but not so fast you hit the cap early (and
 * idle until the window rolls)? And lays the windows' reset times onto a shared
 * timeline so several accounts can be compared at a glance.
 *
 * Two complementary methods, one per window:
 *   - SESSION uses the measured burn rate: compare the actual %/min against the
 *     IDEAL %/min (= headroom ÷ minutes-to-reset) you could sustain to land
 *     exactly at the cap when the window resets.
 *   - WEEKLY has no per-minute burn signal, so it uses position-in-window: given
 *     a 7-day window, compare actual used% to the linear expectation for how far
 *     into the window we are. Positive "slack" = under the line (underusing).
 *
 * No IO. Deterministic given a `now`.
 */

import type { UsageWindow } from '../types/index.js';

/** Default length of the weekly window (Claude Max), in minutes. */
export const WEEKLY_WINDOW_MIN = 7 * 24 * 60;

/** Ratio bands for the session verdict (actual ÷ ideal). */
const FAST_RATIO = 1.15;
const SLOW_RATIO = 0.85;

/** Slack (expected − actual used%) bands for the weekly verdict, in points. */
const WEEKLY_SLACK_PTS = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Minutes until a window resets, or undefined when unknown. Never negative. */
function endsInMin(w: UsageWindow | undefined, now: Date): number | undefined {
  if (!w?.resetAt) return undefined;
  const ms = Date.parse(w.resetAt) - now.getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, ms) / 60_000;
}

export type PaceVerdict =
  | 'too-fast' // burning faster than ideal — will hit the cap before reset, then idle
  | 'on-pace' // tracking the ideal burn — minimal waste
  | 'underusing' // burning slower than ideal — budget will be left unspent at reset
  | 'idle' // healthy budget but no measured consumption right now
  | 'capped' // at/over the cap — nothing left to spend this window
  | 'unknown'; // not enough data

export interface PaceInfo {
  /** Current used percent of this window, when known. */
  usedPct?: number;
  /** Headroom to the cap (session) or to 100% (weekly), percentage points. */
  remainingPct?: number;
  /** Minutes until this window resets, when known. */
  resetInMin?: number;
  /** The %/min you could sustain to exhaust the window exactly at reset. */
  idealPctPerMin?: number;
  /** Measured %/min burn (session); derived avg for weekly. */
  actualPctPerMin?: number;
  /** actual ÷ ideal. >1 too fast, <1 underusing. */
  ratio?: number;
  /** Minutes until the cap/budget is hit at the current pace, when burning. */
  exhaustInMin?: number;
  /**
   * Budget unspent at reset if the current pace holds (percentage points).
   * For weekly this is the "slack" vs the linear burn line (positive = under).
   */
  leftoverPct?: number;
  verdict: PaceVerdict;
}

function verdictFromRatio(ratio: number): PaceVerdict {
  if (ratio > FAST_RATIO) return 'too-fast';
  if (ratio < SLOW_RATIO) return 'underusing';
  return 'on-pace';
}

/**
 * Session pace from the measured burn rate. `capPct` is the effective cap (used-
 * percent at which routing defers the account); defaults to 100 (no cap).
 */
export function computeSessionPace(opts: {
  session?: UsageWindow;
  capPct?: number;
  burnPctPerMin?: number;
  now?: Date;
}): PaceInfo {
  const now = opts.now ?? new Date();
  const used = opts.session?.usedPct;
  const info: PaceInfo = { usedPct: used, verdict: 'unknown' };
  if (used == null) return info;

  const cap = opts.capPct ?? 100;
  const remaining = clamp(cap - used, 0, 100);
  info.remainingPct = remaining;
  if (remaining <= 0) {
    info.verdict = 'capped';
    return info;
  }

  const resetInMin = endsInMin(opts.session, now);
  info.resetInMin = resetInMin;
  if (resetInMin != null && resetInMin > 0) {
    info.idealPctPerMin = remaining / resetInMin;
  }

  const actual = opts.burnPctPerMin;
  if (actual == null || actual <= 0) {
    // Healthy budget, nothing being consumed — money on the table.
    info.verdict = 'idle';
    return info;
  }
  info.actualPctPerMin = actual;
  info.exhaustInMin = remaining / actual;
  if (resetInMin != null) info.leftoverPct = remaining - actual * resetInMin;
  if (info.idealPctPerMin != null && info.idealPctPerMin > 0) {
    info.ratio = actual / info.idealPctPerMin;
    info.verdict = verdictFromRatio(info.ratio);
  }
  return info;
}

/**
 * Weekly pace from position-in-window: with no per-minute weekly burn signal we
 * compare the used percent to the linear expectation for how far into the 7-day
 * window we are. `leftoverPct` carries the slack (expected − actual): positive
 * means you are UNDER the line (underusing), negative means ahead of it.
 */
export function computeWeeklyPace(opts: {
  weekly?: UsageWindow;
  windowMin?: number;
  now?: Date;
}): PaceInfo {
  const now = opts.now ?? new Date();
  const used = opts.weekly?.usedPct;
  const info: PaceInfo = { usedPct: used, verdict: 'unknown' };
  if (used == null) return info;

  const windowMin = opts.windowMin ?? WEEKLY_WINDOW_MIN;
  const remaining = clamp(100 - used, 0, 100);
  info.remainingPct = remaining;
  if (remaining <= 0) {
    info.verdict = 'capped';
    return info;
  }

  const resetInMin = endsInMin(opts.weekly, now);
  info.resetInMin = resetInMin;
  if (resetInMin == null) return info;

  const elapsedMin = clamp(windowMin - resetInMin, 0, windowMin);
  const expectedUsed = clamp((elapsedMin / windowMin) * 100, 0, 100);
  const slack = expectedUsed - used; // + = under the line (underusing)
  info.leftoverPct = slack;

  info.idealPctPerMin = 100 / windowMin;
  if (elapsedMin > 0) {
    info.actualPctPerMin = used / elapsedMin;
    info.exhaustInMin = remaining / info.actualPctPerMin;
    info.ratio = info.actualPctPerMin / info.idealPctPerMin;
  }
  info.verdict =
    slack > WEEKLY_SLACK_PTS
      ? 'underusing'
      : slack < -WEEKLY_SLACK_PTS
        ? 'too-fast'
        : 'on-pace';
  return info;
}

export interface AccountPace {
  name?: string;
  session?: PaceInfo;
  weekly?: PaceInfo;
  /**
   * Which window actually limits this account right now: the one whose budget
   * would run out before it resets, soonest. Undefined when neither will
   * exhaust before reset (you have headroom both ways).
   */
  binding?: 'session' | 'weekly';
}

/** Combine both windows for one account, including the binding constraint. */
export function computeAccountPace(opts: {
  name?: string;
  session?: UsageWindow;
  weekly?: UsageWindow;
  capPct?: number;
  burnPctPerMin?: number;
  weeklyWindowMin?: number;
  now?: Date;
}): AccountPace {
  const session = computeSessionPace({
    session: opts.session,
    capPct: opts.capPct,
    burnPctPerMin: opts.burnPctPerMin,
    now: opts.now,
  });
  const weekly = computeWeeklyPace({
    weekly: opts.weekly,
    windowMin: opts.weeklyWindowMin,
    now: opts.now,
  });

  // A window "binds" when it will exhaust before its own reset.
  const willExhaust = (p: PaceInfo): number | undefined =>
    p.exhaustInMin != null && p.resetInMin != null && p.exhaustInMin < p.resetInMin
      ? p.exhaustInMin
      : undefined;
  const se = willExhaust(session);
  const we = willExhaust(weekly);
  let binding: AccountPace['binding'];
  if (se != null && we != null) binding = se <= we ? 'session' : 'weekly';
  else if (se != null) binding = 'session';
  else if (we != null) binding = 'weekly';

  return { name: opts.name, session, weekly, binding };
}

// ──────────────────────────────────────────────────────────────────────────
// Reset-timeline geometry (shared horizon, per-account marker columns)
// ──────────────────────────────────────────────────────────────────────────

export interface ResetMarker {
  kind: 'session' | 'weekly';
  /** Column index 0..width-1 on the shared track. */
  col: number;
  /** Minutes until this reset (for the label). */
  inMin: number;
}

export interface TimelineRow {
  name: string;
  markers: ResetMarker[];
}

export interface TimelineGeometry {
  /** The furthest reset placed (right edge of the track), in minutes. */
  horizonMin: number;
  /** Track width in columns. */
  width: number;
  rows: TimelineRow[];
}

/**
 * Lay every account's session/weekly reset onto a single shared time track that
 * runs from `now` (col 0) to the furthest reset (col width-1), so the rows are
 * directly comparable. Pure; deterministic given `now`.
 */
export function buildResetTimeline(opts: {
  accounts: Array<{ name: string; session?: UsageWindow; weekly?: UsageWindow }>;
  now?: Date;
  width?: number;
}): TimelineGeometry {
  const now = opts.now ?? new Date();
  const width = Math.max(8, opts.width ?? 40);

  let horizonMin = 60; // a sane minimum span so a "now" reset isn't the whole bar
  for (const a of opts.accounts) {
    for (const w of [a.session, a.weekly]) {
      const m = endsInMin(w, now);
      if (m != null && m > horizonMin) horizonMin = m;
    }
  }

  const place = (
    kind: 'session' | 'weekly',
    w: UsageWindow | undefined
  ): ResetMarker | undefined => {
    const inMin = endsInMin(w, now);
    if (inMin == null) return undefined;
    const col = clamp(Math.round((inMin / horizonMin) * (width - 1)), 0, width - 1);
    return { kind, col, inMin };
  };

  const rows: TimelineRow[] = opts.accounts.map((a) => ({
    name: a.name,
    markers: [place('session', a.session), place('weekly', a.weekly)].filter(
      (m): m is ResetMarker => m != null
    ),
  }));

  return { horizonMin, width, rows };
}

// ──────────────────────────────────────────────────────────────────────────
// Span formatting ("now" / "35m" / "2h10m" / "5d1h")
// ──────────────────────────────────────────────────────────────────────────

/** Compact human span for a minutes value: "now", "35m", "2h10m", "5d1h". */
export function formatSpan(min: number | undefined): string {
  if (min == null || Number.isNaN(min)) return '?';
  const m = Math.round(min);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h${rem}m` : `${h}h`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h ? `${d}d${h}h` : `${d}d`;
}
