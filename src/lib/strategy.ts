/**
 * Pure routing-strategy helpers for claude-profiles.
 *
 * DESIGN INVARIANT — "never hard-drop":
 *   `applyRouting` never removes a candidate from the returned `ordered` list.
 *   Ineligible candidates are moved to the back so the chain always has something
 *   to fall back to; the caller decides whether to act on their `deferred` reasons.
 *
 * No IO is performed here. All functions are pure and deterministic when a clock
 * value and an optional `rand` function are provided by the caller.
 */

import type {
  RoutingStrategy,
  RoutingPolicy,
  RoutingConfig,
  UsageBudget,
  UsageWindow,
} from '../types/index.js';

// ──────────────────────────────────────────────────────────────────────────────
// Local private helpers (not exported — avoid importing from usage.ts)
// ──────────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Returns the percentage of the budget still remaining, or `undefined` if the
 * window's `usedPct` is unknown.
 */
function pctRemaining(window: UsageWindow | undefined): number | undefined {
  if (window?.usedPct == null) return undefined;
  return clamp(100 - window.usedPct, 0, 100);
}

/**
 * Returns how many milliseconds until the window resets, or `undefined` if the
 * `resetAt` field is absent or unparseable. Never returns a negative number.
 */
function windowEndsInMs(window: UsageWindow | undefined, now: number): number | undefined {
  if (!window?.resetAt) return undefined;
  const resetMs = Date.parse(window.resetAt);
  if (Number.isNaN(resetMs)) return undefined;
  return Math.max(0, resetMs - now);
}

// ──────────────────────────────────────────────────────────────────────────────
// Public input type
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Minimal, router-agnostic representation of a candidate to be ordered.
 * The caller (router.ts) constructs these from Profile + ProfileRuntimeState.
 */
export interface RoutableCandidate {
  /** Profile alias / identifier. */
  name: string;
  /** `false` when the profile is on cooldown or needs re-auth. */
  healthy: boolean;
  /** Position in the resolved chain order (0 = first defined). */
  priorityIndex: number;
  /** Weight for the `weighted` strategy; defaults to `capacity`, then 1. */
  weight?: number;
  /**
   * Plan capacity multiplier (Pro = 1, Max-5× = 5, Max-20× = 20). Used as the
   * default `weighted` weight when `weight` is unset, and to scale
   * `most-remaining` from a percentage into absolute headroom.
   */
  capacity?: number;
  /** Last-known budget; may be undefined if never observed. */
  usage?: UsageBudget;
  /** ISO timestamp of last selection; drives `round-robin`. */
  lastUsedAt?: string;
  /** Effective policy for this candidate (already merged by the caller). */
  policy?: RoutingPolicy;
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. evaluateEligibility
// ──────────────────────────────────────────────────────────────────────────────

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Evaluate all policy gates for a single candidate.
 *
 * Rules:
 * - A missing policy → always eligible (reasons: []).
 * - If a gate's usage data is UNKNOWN (undefined), the gate PASSES — we cannot
 *   prove ineligibility.
 * - All failing gates accumulate into `reasons`; the first failure sets
 *   `eligible = false`.
 */
export function evaluateEligibility(
  candidate: RoutableCandidate,
  now?: Date,
): EligibilityResult {
  const policy = candidate.policy;
  if (!policy) return { eligible: true, reasons: [] };

  const nowMs = (now ?? new Date()).getTime();
  const reasons: string[] = [];

  // Gate: minWeeklyRemaining
  if (policy.minWeeklyRemaining != null) {
    const remaining = pctRemaining(candidate.usage?.weekly);
    if (remaining != null && remaining < policy.minWeeklyRemaining) {
      reasons.push(
        `weekly budget ${Math.round(remaining)}% < ${policy.minWeeklyRemaining}% required`,
      );
    }
    // If remaining is undefined (unknown), the gate passes silently.
  }

  // Gate: minSessionRemaining
  if (policy.minSessionRemaining != null) {
    const remaining = pctRemaining(candidate.usage?.session);
    if (remaining != null && remaining < policy.minSessionRemaining) {
      reasons.push(
        `session budget ${Math.round(remaining)}% < ${policy.minSessionRemaining}% required`,
      );
    }
  }

  // Gate: avoidIfWindowEndsWithinMin
  if (policy.avoidIfWindowEndsWithinMin != null) {
    const endsInMs = windowEndsInMs(candidate.usage?.session, nowMs);
    if (endsInMs != null) {
      const endsInMin = endsInMs / 60_000;
      if (endsInMin <= policy.avoidIfWindowEndsWithinMin) {
        const endsInMinRounded = Math.round(endsInMin);
        reasons.push(
          `session window resets in ${endsInMinRounded}m (avoid < ${policy.avoidIfWindowEndsWithinMin}m)`,
        );
      }
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. applyStrategy
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Reorder `candidates` according to `strategy`. The input array is never
 * mutated; a new array is returned.
 *
 * `least-used` strategy note: profiles with unknown `usedPct` are treated as
 * 0% used (freshest), so they sort before known-low profiles. Document this so
 * callers know unknown === "assume fresh".
 *
 * `most-remaining` strategy note: profiles with unknown session `usedPct` are
 * treated as 100% remaining. Unknown `windowEndsInMs` is treated as Infinity
 * (sorts first among ties).
 */
export function applyStrategy(
  strategy: RoutingStrategy,
  candidates: RoutableCandidate[],
  now?: Date,
  rand: () => number = Math.random,
): RoutableCandidate[] {
  const nowMs = (now ?? new Date()).getTime();
  // Work on a shallow copy so we never mutate the caller's array.
  const list = [...candidates];

  switch (strategy) {
    case 'priority': {
      return list.sort((a, b) => a.priorityIndex - b.priorityIndex);
    }

    case 'round-robin': {
      return list.sort((a, b) => {
        const aMs = a.lastUsedAt ? Date.parse(a.lastUsedAt) : -Infinity;
        const bMs = b.lastUsedAt ? Date.parse(b.lastUsedAt) : -Infinity;
        if (aMs !== bMs) return aMs - bMs; // never-used (-Infinity) sorts first
        return a.priorityIndex - b.priorityIndex;
      });
    }

    case 'least-used': {
      return list.sort((a, b) => {
        // unknown usedPct → treat as 0 (freshest) → sorts first
        const aUsed = a.usage?.session?.usedPct ?? 0;
        const bUsed = b.usage?.session?.usedPct ?? 0;
        if (aUsed !== bUsed) return aUsed - bUsed;
        return a.priorityIndex - b.priorityIndex;
      });
    }

    case 'most-remaining': {
      return list.sort((a, b) => {
        // unknown → treat as 100% remaining; scale by plan capacity so a 20×
        // account at 50% outranks a 5× account at 50% (more *absolute* runway).
        const aRem = (pctRemaining(a.usage?.session) ?? 100) * (a.capacity ?? 1);
        const bRem = (pctRemaining(b.usage?.session) ?? 100) * (b.capacity ?? 1);
        if (aRem !== bRem) return bRem - aRem; // higher remaining first

        // secondary: window ending furthest in the future first (more runway)
        const aEnds = windowEndsInMs(a.usage?.session, nowMs) ?? Infinity;
        const bEnds = windowEndsInMs(b.usage?.session, nowMs) ?? Infinity;
        if (aEnds !== bEnds) return bEnds - aEnds;

        return a.priorityIndex - b.priorityIndex;
      });
    }

    case 'weighted': {
      // Weighted random selection without replacement.
      // Non-positive weights are treated as a tiny epsilon so every candidate
      // still appears in the output.
      const EPSILON = 1e-9;
      const remaining = list.map(c => ({
        candidate: c,
        // Explicit weight wins; otherwise fall back to the plan capacity.
        weight: Math.max(c.weight ?? c.capacity ?? 1, EPSILON),
      }));
      const result: RoutableCandidate[] = [];

      while (remaining.length > 0) {
        const total = remaining.reduce((sum, r) => sum + r.weight, 0);
        let pick = rand() * total;
        let idx = 0;
        for (let i = 0; i < remaining.length; i++) {
          pick -= remaining[i].weight;
          if (pick <= 0) {
            idx = i;
            break;
          }
          // If floating-point dust means we never go <= 0, fall back to last.
          idx = i;
        }
        result.push(remaining[idx].candidate);
        remaining.splice(idx, 1);
      }

      return result;
    }

    default: {
      // Exhaustiveness guard — TypeScript will warn if a case is missing.
      const _never: never = strategy;
      return list;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. applyPreferenceBoost
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Stable-move any candidate whose `policy.preferIfWindowEndsWithinMin` is set
 * AND whose session window ends within that many minutes to the FRONT of the
 * list, preserving relative order within each group.
 *
 * Pure — input is not mutated.
 */
export function applyPreferenceBoost(
  candidates: RoutableCandidate[],
  now?: Date,
): RoutableCandidate[] {
  const nowMs = (now ?? new Date()).getTime();
  const boosted: RoutableCandidate[] = [];
  const rest: RoutableCandidate[] = [];

  for (const c of candidates) {
    const threshold = c.policy?.preferIfWindowEndsWithinMin;
    if (threshold != null) {
      const endsInMs = windowEndsInMs(c.usage?.session, nowMs);
      if (endsInMs != null && endsInMs / 60_000 <= threshold) {
        boosted.push(c);
        continue;
      }
    }
    rest.push(c);
  }

  return [...boosted, ...rest];
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. applyRouting
// ──────────────────────────────────────────────────────────────────────────────

export interface ApplyRoutingResult {
  /**
   * NEVER-HARD-DROP INVARIANT: every candidate from the input appears exactly
   * once in `ordered`. Ineligible and unhealthy candidates are moved to the
   * back rather than removed, so the chain always has something to try.
   *
   * Order: [eligible+healthy (strategy-ordered + preference-boosted)]
   *        [eligible+unhealthy (priorityIndex order)]
   *        [ineligible (priorityIndex order)]
   */
  ordered: RoutableCandidate[];
  /** Ineligible candidates with the reasons they were demoted. */
  deferred: Array<{ name: string; reasons: string[] }>;
}

export function applyRouting(opts: {
  candidates: RoutableCandidate[];
  strategy?: RoutingStrategy;
  now?: Date;
  rand?: () => number;
}): ApplyRoutingResult {
  const { candidates, strategy = 'priority', now, rand } = opts;

  const eligibleHealthy: RoutableCandidate[] = [];
  const eligibleUnhealthy: RoutableCandidate[] = [];
  const ineligible: RoutableCandidate[] = [];
  const deferred: Array<{ name: string; reasons: string[] }> = [];

  // a. Split by eligibility, then by health within the eligible group.
  for (const c of candidates) {
    const result = evaluateEligibility(c, now);
    if (!result.eligible) {
      ineligible.push(c);
      deferred.push({ name: c.name, reasons: result.reasons });
    } else if (c.healthy) {
      eligibleHealthy.push(c);
    } else {
      eligibleUnhealthy.push(c);
    }
  }

  // b+c. Order eligible-healthy by strategy, then apply preference boost.
  const orderedHealthy = applyPreferenceBoost(
    applyStrategy(strategy, eligibleHealthy, now, rand),
    now,
  );

  // d. Stable sort unhealthy and ineligible by priorityIndex.
  const sortedUnhealthy = [...eligibleUnhealthy].sort(
    (a, b) => a.priorityIndex - b.priorityIndex,
  );
  const sortedIneligible = [...ineligible].sort(
    (a, b) => a.priorityIndex - b.priorityIndex,
  );

  return {
    ordered: [...orderedHealthy, ...sortedUnhealthy, ...sortedIneligible],
    deferred,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. resolveStrategy
// ──────────────────────────────────────────────────────────────────────────────

export interface ResolvedStrategy {
  strategy: RoutingStrategy;
  policy?: RoutingPolicy;
}

/**
 * Merge global and per-chain routing configs.
 *
 * - Strategy: perChain wins; falls back to global; defaults to `'priority'`.
 * - Policy: shallow-merge global first, then perChain fields overwrite
 *   (perChain wins field-by-field).
 */
export function resolveStrategy(
  global?: RoutingConfig,
  perChain?: RoutingConfig,
): ResolvedStrategy {
  const strategy: RoutingStrategy =
    perChain?.strategy ?? global?.strategy ?? 'priority';

  const mergedPolicy: RoutingPolicy = {
    ...(global?.policy ?? {}),
    ...(perChain?.policy ?? {}),
  };

  const hasPolicy = Object.keys(mergedPolicy).length > 0;

  return {
    strategy,
    policy: hasPolicy ? mergedPolicy : undefined,
  };
}
