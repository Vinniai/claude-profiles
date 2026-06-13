/**
 * Pure cutover math for claude-profiles.
 *
 * Turns the free statusline usage snapshots into the live routing signals the
 * UI and router need:
 *   - the EFFECTIVE session cap for an account (base policy cap, raised by a
 *     temporary "push past the cap" override that auto-expires),
 *   - a BURN RATE (percent/min and percent/turn) from two successive
 *     observations of the rolling session window,
 *   - a COUNTDOWN to the cap (minutes and a rough turn estimate),
 *   - the resolved "up next" account from the same ordering the router uses.
 *
 * No IO. Everything is deterministic given a `now` (and the values passed in).
 */

import type {
  BurnRate,
  CapOverride,
  HourWindow,
  RoutingPolicy,
  UsageWindow,
} from '../types/index.js';
import {
  applyRouting,
  evaluateEligibility,
  isPreferenceBoosted,
  isWithinPreferredHours,
  type RoutableCandidate,
} from './strategy.js';
import type { RoutingStrategy } from '../types/index.js';

/** Cap used when a chain has no explicit `minSessionRemaining` policy. */
export const DEFAULT_SESSION_CAP_PCT = 90;

/** EWMA smoothing factor for burn estimates (favor recent samples a bit). */
const BURN_ALPHA = 0.5;

/**
 * Minimum elapsed window (minutes) before the per-minute anchor advances and a
 * burn sample is taken. Below this, the gap is render jitter — the statusLine
 * fires many times a minute — and dividing a usage delta by a near-zero Δt
 * yields an explosive rate. One minute gives a stable, trustworthy figure.
 */
const MIN_BURN_DT_MIN = 1;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ──────────────────────────────────────────────────────────────────────────
// Cap resolution
// ──────────────────────────────────────────────────────────────────────────

/**
 * The base session cap implied by a routing policy: the used-percent at which
 * `minSessionRemaining` would defer the account. Undefined when the policy sets
 * no session floor (no cap configured).
 */
export function baseCapPct(policy: RoutingPolicy | undefined): number | undefined {
  if (policy?.minSessionRemaining == null) return undefined;
  return clamp(100 - policy.minSessionRemaining, 0, 100);
}

/** Return the override only if it exists and has not yet expired. */
export function activeOverride(
  override: CapOverride | undefined,
  now: Date = new Date(),
): CapOverride | undefined {
  if (!override) return undefined;
  if (override.until) {
    const until = Date.parse(override.until);
    if (!Number.isNaN(until) && until <= now.getTime()) return undefined;
  }
  return override;
}

/**
 * The effective session cap for an account: the override's cap when one is
 * active, otherwise the base policy cap. Undefined when neither is set.
 */
export function effectiveCapPct(
  policy: RoutingPolicy | undefined,
  override: CapOverride | undefined,
  now: Date = new Date(),
): number | undefined {
  const ov = activeOverride(override, now);
  if (ov) return clamp(ov.sessionCapPct, 0, 100);
  return baseCapPct(policy);
}

/**
 * The effective `minSessionRemaining` for routing eligibility once a cap
 * override is applied. Lets the router skip an over-cap account on the next
 * launch — and keep using one the user has explicitly pushed. Undefined when no
 * cap is in force (no policy floor and no override).
 */
export function effectiveMinSessionRemaining(
  policy: RoutingPolicy | undefined,
  override: CapOverride | undefined,
  now: Date = new Date(),
): number | undefined {
  const cap = effectiveCapPct(policy, override, now);
  if (cap == null) return policy?.minSessionRemaining;
  return clamp(100 - cap, 0, 100);
}

// ──────────────────────────────────────────────────────────────────────────
// Burn rate (from two successive session observations)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Update the burn-rate estimate from the previous and current session windows.
 *
 * The statusLine fires on every render — often seconds apart during streaming —
 * so a naive "dPct between the last two observations / dt" explodes when dt is
 * tiny. Instead the PER-MINUTE rate is measured against a slow-moving ANCHOR
 * that only advances once a real ≥`MIN_BURN_DT_MIN` window has elapsed, so the
 * figure reflects sustained consumption rather than render jitter. The PER-TURN
 * rate stays a per-change delta (each meaningful jump ≈ one turn). Both are
 * EWMA-smoothed. Returns `existing` only when there is nothing usable at all.
 */
export function updateBurnRate(
  prev: UsageWindow | undefined,
  cur: UsageWindow | undefined,
  existing: BurnRate | undefined,
  now: Date = new Date(),
): BurnRate | undefined {
  if (cur?.usedPct == null) return existing;
  const curAt = cur.observedAt ? Date.parse(cur.observedAt) : now.getTime();
  const next: BurnRate = { ...existing, at: now.toISOString() };

  // ── Per-turn: change since the immediately previous render, when it's a rise.
  if (prev?.usedPct != null) {
    const dTurn = cur.usedPct - prev.usedPct;
    if (dTurn > 0) {
      next.pctPerTurn =
        existing?.pctPerTurn == null
          ? dTurn
          : BURN_ALPHA * dTurn + (1 - BURN_ALPHA) * existing.pctPerTurn;
    }
  }

  // ── Per-minute: measured against the slow anchor.
  // Establish the anchor: an existing one, else seed from prev (gives a head
  // start), else from the current observation.
  let anchorPct = existing?.anchorPct;
  let anchorAt = existing?.anchorAt ? Date.parse(existing.anchorAt) : NaN;
  if (anchorPct == null || Number.isNaN(anchorAt)) {
    if (prev?.usedPct != null && prev.observedAt) {
      anchorPct = prev.usedPct;
      anchorAt = Date.parse(prev.observedAt);
    } else {
      anchorPct = cur.usedPct;
      anchorAt = curAt;
    }
  }

  if (cur.usedPct < anchorPct || Number.isNaN(anchorAt)) {
    // Usage dropped (window reset) — re-anchor here, keep the prior rate.
    anchorPct = cur.usedPct;
    anchorAt = curAt;
  } else {
    const dMin = (curAt - anchorAt) / 60_000;
    const dPct = cur.usedPct - anchorPct;
    if (dMin >= MIN_BURN_DT_MIN && dPct > 0) {
      const sample = dPct / dMin;
      next.sessionPctPerMin =
        existing?.sessionPctPerMin == null
          ? sample
          : BURN_ALPHA * sample + (1 - BURN_ALPHA) * existing.sessionPctPerMin;
      // Window satisfied — advance the anchor to here.
      anchorPct = cur.usedPct;
      anchorAt = curAt;
    }
    // Otherwise keep the anchor put so wall-clock time can accumulate.
  }

  next.anchorPct = anchorPct;
  next.anchorAt = new Date(anchorAt).toISOString();
  return next;
}

// ──────────────────────────────────────────────────────────────────────────
// Countdown
// ──────────────────────────────────────────────────────────────────────────

export interface CutoverInfo {
  /** Effective cap (override-adjusted), percent used. Undefined = no cap. */
  capPct?: number;
  /** Current session usage percent, if known. */
  usedPct?: number;
  /** Headroom to the cap in percentage points (negative when over). */
  remainingPct?: number;
  /** True once usage has reached/passed the effective cap. */
  overCap: boolean;
  /** Estimated minutes until the cap is hit at the current burn rate. */
  etaMin?: number;
  /** Rough estimated turns until the cap is hit. */
  etaTurns?: number;
  /** True when a push override is currently raising the cap. */
  overridden: boolean;
}

/**
 * Combine the session window, policy, override and burn rate into the cutover
 * countdown. Pure; safe to call on every statusline render.
 */
export function computeCutover(opts: {
  session: UsageWindow | undefined;
  policy?: RoutingPolicy;
  override?: CapOverride;
  burn?: BurnRate;
  now?: Date;
}): CutoverInfo {
  const now = opts.now ?? new Date();
  const capPct = effectiveCapPct(opts.policy, opts.override, now);
  const usedPct = opts.session?.usedPct;
  const overridden = activeOverride(opts.override, now) != null;

  const info: CutoverInfo = { capPct, usedPct, overCap: false, overridden };
  if (capPct == null || usedPct == null) return info;

  const remainingPct = capPct - usedPct;
  info.remainingPct = remainingPct;
  info.overCap = remainingPct <= 0;
  if (info.overCap) return info;

  const perMin = opts.burn?.sessionPctPerMin;
  if (perMin && perMin > 0) info.etaMin = Math.max(0, Math.round(remainingPct / perMin));

  const perTurn = opts.burn?.pctPerTurn;
  if (perTurn && perTurn > 0) {
    info.etaTurns = Math.max(1, Math.round(remainingPct / perTurn));
  }
  return info;
}

// ──────────────────────────────────────────────────────────────────────────
// Drain rule ("use the about-to-reset session, gated by weekly budget")
// ──────────────────────────────────────────────────────────────────────────

/** Minutes until a window resets, or undefined when unknown. Never negative. */
function windowEndsInMin(w: UsageWindow | undefined, now: Date): number | undefined {
  if (!w?.resetAt) return undefined;
  const ms = Date.parse(w.resetAt) - now.getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, ms) / 60_000;
}

export interface DrainInfo {
  /** The "≤ N min to reset" preference threshold (minutes). */
  preferWithinMin: number;
  /** Weekly-remaining floor gating the rule (percent), when configured. */
  weeklyFloorPct?: number;
  /** Minutes until the session window resets, when known. */
  windowEndsInMin?: number;
  /** Weekly budget remaining (percent), when known. */
  weeklyRemainingPct?: number;
  /**
   * - `active`     → window is close AND weekly is healthy → preferred now.
   * - `conserving` → weekly is at/below the floor → held back (last-resort).
   * - `idle`       → eligible, but the window isn't close enough yet.
   */
  state: 'active' | 'conserving' | 'idle';
}

/**
 * Describe a profile's "drain" rule for display: prefer this account while its
 * session window is about to reset (so its soon-to-roll budget gets used),
 * gated by a weekly-remaining floor so we don't burn the weekly allowance.
 * Mirrors how the router actually behaves (`preferIfWindowEndsWithinMin` boost,
 * applied only while `minWeeklyRemaining` keeps the candidate eligible).
 *
 * Returns undefined when the profile has no `preferIfWindowEndsWithinMin` set —
 * i.e. no drain rule is configured for it.
 */
export function computeDrain(opts: {
  session?: UsageWindow;
  weekly?: UsageWindow;
  policy?: RoutingPolicy;
  now?: Date;
}): DrainInfo | undefined {
  const preferWithinMin = opts.policy?.preferIfWindowEndsWithinMin;
  if (preferWithinMin == null) return undefined;
  const now = opts.now ?? new Date();
  const weeklyFloorPct = opts.policy?.minWeeklyRemaining;

  const endsInMin = windowEndsInMin(opts.session, now);
  const weeklyRemainingPct =
    opts.weekly?.usedPct == null ? undefined : clamp(100 - opts.weekly.usedPct, 0, 100);

  // Unknown weekly passes the gate (consistent with eligibility semantics).
  const belowFloor =
    weeklyFloorPct != null &&
    weeklyRemainingPct != null &&
    weeklyRemainingPct < weeklyFloorPct;
  const windowClose = endsInMin != null && endsInMin <= preferWithinMin;

  const state: DrainInfo['state'] = belowFloor
    ? 'conserving'
    : windowClose
      ? 'active'
      : 'idle';

  return {
    preferWithinMin,
    weeklyFloorPct,
    windowEndsInMin: endsInMin,
    weeklyRemainingPct,
    state,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Schedule rule ("prefer this account during a recurring time-of-day window")
// ──────────────────────────────────────────────────────────────────────────

/** Format an hour (0–23) as a 12-hour clock label: 0→"12am", 13→"1pm". */
export function formatHour(h: number): string {
  const norm = ((h % 24) + 24) % 24;
  const period = norm < 12 ? 'am' : 'pm';
  const display = norm % 12 === 0 ? 12 : norm % 12;
  return `${display}${period}`;
}

export interface ScheduleInfo {
  /** The configured preferred window (local time). */
  hours: HourWindow;
  /** True when `now`'s local hour falls inside the window. */
  withinWindow: boolean;
  /**
   * - `active` → the current hour is inside the window → preferred now.
   * - `idle`   → outside the window → no boost right now.
   */
  state: 'active' | 'idle';
}

/**
 * Describe a profile's "schedule" rule for display: prefer this account during a
 * recurring time-of-day window (e.g. 9pm–1am, when its owner is asleep). Mirrors
 * the router's `preferHours` boost — applied only while the account stays
 * eligible, so it composes with the weekly/session gates automatically.
 *
 * Returns undefined when the profile has no `preferHours` set.
 */
export function computeSchedule(opts: {
  policy?: RoutingPolicy;
  now?: Date;
}): ScheduleInfo | undefined {
  const hours = opts.policy?.preferHours;
  if (!hours) return undefined;
  const now = opts.now ?? new Date();
  const withinWindow = isWithinPreferredHours(hours, now);
  return {
    hours,
    withinWindow,
    state: withinWindow ? 'active' : 'idle',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Up next
// ──────────────────────────────────────────────────────────────────────────

export interface UpNext {
  /** The account routing would move to after `current`, or null if none. */
  name: string | null;
  /** That account's remaining session budget (percent), when known. */
  remainingPct?: number;
}

/**
 * Resolve who is "up next" by running the same ordering the router uses, then
 * returning the first account that is not the one currently in use. `candidates`
 * should already carry each account's cached usage, health, policy and
 * priority — exactly what the statusline assembles from config + state.
 */
export function resolveUpNext(
  candidates: RoutableCandidate[],
  current: string | undefined,
  strategy: RoutingStrategy = 'priority',
  now: Date = new Date(),
): UpNext {
  if (candidates.length === 0) return { name: null };
  const { ordered } = applyRouting({ candidates, strategy, now });
  const healthyFirst = ordered.filter((c) => c.healthy);
  const pool = healthyFirst.length > 0 ? healthyFirst : ordered;
  const next = pool.find((c) => c.name !== current) ?? null;
  if (!next) return { name: null };
  const remaining =
    next.usage?.session?.usedPct != null
      ? clamp(100 - next.usage.session.usedPct, 0, 100)
      : undefined;
  return { name: next.name, remainingPct: remaining };
}

// ──────────────────────────────────────────────────────────────────────────
// Proactive auto-switch (turn-boundary account move, pre-empting a limit)
// ──────────────────────────────────────────────────────────────────────────

export interface AutoSwitchDecision {
  /** The account work should move to. */
  to: string;
  /** Human-readable reason, suitable for the user-facing banner + routing log. */
  reason: string;
  /** Always `'policy'` — a proactive, rule-driven switch (not an error failover). */
  kind: 'policy';
}

/** Phrase why a soft rule now prefers `target` (schedule before drain). */
function preferenceReason(target: RoutableCandidate, now: Date): string {
  if (isWithinPreferredHours(target.policy?.preferHours, now)) {
    return `entered ${target.name}'s preferred hours — switching to it`;
  }
  return `${target.name}'s session is about to reset — switching to drain it`;
}

/**
 * Decide whether a supervised interactive session should proactively switch off
 * `current` at this turn boundary, given the same routable candidates the router
 * builds. Returns the target + reason when a routing RULE favours moving, else
 * undefined (stay put). Pure; deterministic given `now`.
 *
 * Switches on exactly the three rules the user opted into:
 *   1. `over-cap`  — `current` is no longer eligible (it hit its effective
 *      session cap), and a healthy eligible alternative exists.
 *   2. `schedule`  — the top-ordered alternative entered its `preferHours`
 *      window while `current` is not itself preferred.
 *   3. `drain`     — the top-ordered alternative's session is about to reset
 *      (`preferIfWindowEndsWithinMin`) while `current` is not itself preferred.
 *
 * It never switches on pure strategy churn (round-robin/weighted reordering): a
 * healthy, eligible, non-preferred `current` stays put so a session isn't yanked
 * between accounts every turn. The target must itself be healthy and eligible.
 */
export function decideAutoSwitch(opts: {
  candidates: RoutableCandidate[];
  current: string;
  strategy?: RoutingStrategy;
  now?: Date;
}): AutoSwitchDecision | undefined {
  const now = opts.now ?? new Date();
  const strategy = opts.strategy ?? 'priority';

  const currentC = opts.candidates.find((c) => c.name === opts.current);
  if (!currentC) return undefined;

  const { ordered } = applyRouting({ candidates: opts.candidates, strategy, now });
  const healthyFirst = ordered.filter((c) => c.healthy);
  const pool = healthyFirst.length > 0 ? healthyFirst : ordered;
  const target = pool.find((c) => c.name !== opts.current);

  // Only switch to a genuinely better home: healthy and passing every gate.
  if (!target || !target.healthy) return undefined;
  if (!evaluateEligibility(target, now).eligible) return undefined;

  const currentEligible = evaluateEligibility(currentC, now).eligible;

  // Trigger 1: current account is over its cap (session gate now fails).
  if (!currentEligible) {
    const min = currentC.policy?.minSessionRemaining;
    const reason =
      min != null
        ? `current account over cap${clamp(100 - min, 0, 100)} — switching to ${target.name}`
        : `current account no longer eligible — switching to ${target.name}`;
    return { to: target.name, reason, kind: 'policy' };
  }

  // Triggers 2 & 3: a soft rule now prefers the target while current is not
  // itself preferred (don't bounce off an account a rule still favours).
  if (isPreferenceBoosted(target, now) && !isPreferenceBoosted(currentC, now)) {
    return { to: target.name, reason: preferenceReason(target, now), kind: 'policy' };
  }

  return undefined;
}
