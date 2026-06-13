/**
 * Pure utility functions for Claude Max usage budget tracking.
 *
 * All functions are pure (no I/O, no side effects).  Persistence is the
 * responsibility of the caller.  The module only imports from the shared types
 * and Node built-ins.
 *
 * Background: Claude Max enforces two rolling windows —
 *   - session: a short (~5 h) window with its own request budget
 *   - weekly: a seven-day aggregate budget
 *
 * The Claude CLI exposes plan/identity (`claude auth status --json` and the
 * `oauthAccount` block — see lib/account-info.ts) but NOT live usage-window
 * percentages or reset times. So for the rolling budgets we still do best-effort
 * text extraction from whatever appears in stdout/stderr / rate-limit messages.
 */

import type { UsageBudget, UsageWindow } from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * After this many milliseconds a stored UsageWindow is considered stale and
 * should be re-observed before being trusted for routing decisions (6 hours).
 */
export const USAGE_STALE_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// parseUsageFromText
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of {@link UsageBudget} from free-form Claude CLI
 * output or rate-limit messages.
 *
 * Recognised patterns (all case-insensitive):
 *
 * **Percentages**
 * - `75% of your weekly limit`           → weekly.usedPct = 75
 * - `weekly limit: 80% used`             → weekly.usedPct = 80
 * - `session ... 50%`                    → session.usedPct = 50
 * - `5-hour ... 40%`                     → session.usedPct = 40
 * - `20% of your weekly limit remaining` → weekly.usedPct = 80 (inverted)
 *
 * **Reset times**
 * - Unix epoch  `resets_at: 1718200000` (10–13 digits, seconds or ms)
 * - Human clock `resets at 3:45pm` / `resets at 15:00`
 *   (rolls to tomorrow when the parsed clock time has already passed today)
 *
 * A parsed reset time is associated with the `weekly` window when the
 * surrounding text contains "week"; otherwise with `session`.
 *
 * Populated windows get `observedAt = now.toISOString()` and
 * `source: 'observed'`.  Empty windows are omitted from the result.
 * Never throws.
 *
 * @param text Raw CLI output to parse.
 * @param now  Injected clock for deterministic tests; defaults to `new Date()`.
 */
export function parseUsageFromText(text: string, now: Date = new Date()): UsageBudget {
  const budget: UsageBudget = {};

  // ------------------------------------------------------------------
  // 1. Percentage extraction
  // ------------------------------------------------------------------
  // We scan for all percentage occurrences and figure out their window
  // association + direction (used vs remaining).
  //
  // Supported phrase shapes (case-insensitive):
  //   a) "<n>% of your (session|weekly|5-hour) limit [remaining|left]"
  //   b) "(session|weekly|5-hour) [limit:] <n>% [used|remaining|left]"
  //   c) "<n>% ... (session|weekly|5-hour)"  — fallback, lookahead

  const percentPatterns: Array<{
    re: RegExp;
    /** index of capture group that holds the number */
    numGroup: number;
    /** index of capture group that names the window (may be undefined → infer) */
    windowGroup: number;
    /** index of capture group that signals "remaining" (optional) */
    remainingGroup?: number;
  }> = [
    // Shape a: "N% of your weekly/session limit [remaining]"
    {
      re: /(\d{1,3})%\s+of\s+your\s+(weekly|session|5[-\s]?hour)\s+limit(?:\s+(remaining|left))?/gi,
      numGroup: 1,
      windowGroup: 2,
      remainingGroup: 3,
    },
    // Shape b: "weekly/session limit: N% [used|remaining|left]"
    {
      re: /(weekly|session|5[-\s]?hour)\s+limit[:\s]+(\d{1,3})%(?:\s+(used|remaining|left))?/gi,
      numGroup: 2,
      windowGroup: 1,
      remainingGroup: 3,
    },
    // Shape b2: "weekly/session ... N% used/remaining" (looser)
    {
      re: /(weekly|session|5[-\s]?hour)[^%]{0,40}?(\d{1,3})%\s*(used|remaining|left)/gi,
      numGroup: 2,
      windowGroup: 1,
      remainingGroup: 3,
    },
    // Shape c: "N% [used|remaining] ... weekly/session" (fallback, percentage first)
    {
      re: /(\d{1,3})%\s*(used|remaining|left)?[^%\n]{0,60}?(weekly|session|5[-\s]?hour)/gi,
      numGroup: 1,
      windowGroup: 3,
      remainingGroup: 2,
    },
  ];

  for (const { re, numGroup, windowGroup, remainingGroup } of percentPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = Number(m[numGroup]);
      if (Number.isNaN(raw) || raw < 0 || raw > 100) continue;

      const windowRaw = (m[windowGroup] ?? '').toLowerCase();
      const isWeekly = windowRaw.includes('week');
      // "5-hour" and "session" both map to the session window
      const windowKey: 'weekly' | 'session' = isWeekly ? 'weekly' : 'session';

      const remainingWord = remainingGroup !== undefined
        ? (m[remainingGroup] ?? '').toLowerCase()
        : '';
      const isRemaining = remainingWord === 'remaining' || remainingWord === 'left';
      const usedPct = isRemaining ? 100 - raw : raw;

      const current = budget[windowKey] ?? {};
      // Only set if not already populated (first match wins)
      if (current.usedPct === undefined) {
        budget[windowKey] = {
          ...current,
          usedPct,
          observedAt: now.toISOString(),
          source: 'observed',
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Reset time extraction
  // ------------------------------------------------------------------
  // Two shapes (same as claude-errors.parseResetTime, reimplemented here
  // to keep this module self-contained):
  //
  //   a) Unix epoch:  `resets_at: 1718200000`  (10–13 digit number)
  //   b) Human clock: `resets at 3:45pm`  /  `resets at 15:00`

  // Shape a: epoch
  const epochRe = /["']?resets?_?at["']?\s*[:=]\s*["']?(\d{10,13})/gi;
  let em: RegExpExecArray | null;
  epochRe.lastIndex = 0;
  while ((em = epochRe.exec(text)) !== null) {
    const num = Number(em[1]);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) continue;

    // Find surrounding context to guess the window (100 chars around the match)
    const ctx = text.slice(Math.max(0, em.index - 100), em.index + 100).toLowerCase();
    const windowKey: 'weekly' | 'session' = ctx.includes('week') ? 'weekly' : 'session';

    const current = budget[windowKey] ?? {};
    if (current.resetAt === undefined) {
      budget[windowKey] = {
        ...current,
        resetAt: d.toISOString(),
        observedAt: current.observedAt ?? now.toISOString(),
        source: current.source ?? 'observed',
      };
    }
  }

  // Shape b: human clock "resets at 3:45pm" / "resets at 15:00"
  const humanRe = /resets?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  let hm: RegExpExecArray | null;
  humanRe.lastIndex = 0;
  while ((hm = humanRe.exec(text)) !== null) {
    let hours = Number(hm[1]);
    const minutes = hm[2] !== undefined ? Number(hm[2]) : 0;
    const meridiem = (hm[3] ?? '').toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) continue;

    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);

    const ctx = text.slice(Math.max(0, hm.index - 100), hm.index + 100).toLowerCase();
    const windowKey: 'weekly' | 'session' = ctx.includes('week') ? 'weekly' : 'session';

    const current = budget[windowKey] ?? {};
    if (current.resetAt === undefined) {
      budget[windowKey] = {
        ...current,
        resetAt: d.toISOString(),
        observedAt: current.observedAt ?? now.toISOString(),
        source: current.source ?? 'observed',
      };
    }
  }

  return budget;
}

// ---------------------------------------------------------------------------
// mergeBudget
// ---------------------------------------------------------------------------

/**
 * Merge two {@link UsageBudget} objects, per-window.
 *
 * For each window (`session` / `weekly`):
 *   - If only one side has the window, keep it as-is.
 *   - If both sides have the window, `next` wins field-by-field (prev values
 *     are kept for fields that `next` does not define).
 *
 * Pure — neither input is mutated.
 */
export function mergeBudget(
  prev: UsageBudget | undefined,
  next: UsageBudget | undefined,
): UsageBudget {
  const result: UsageBudget = {};

  const keys: Array<'session' | 'weekly'> = ['session', 'weekly'];
  for (const key of keys) {
    const p = prev?.[key];
    const n = next?.[key];
    if (p === undefined && n === undefined) continue;
    if (p === undefined) { result[key] = { ...n }; continue; }
    if (n === undefined) { result[key] = { ...p }; continue; }
    // Merge field-by-field; next wins for any field it defines
    result[key] = {
      ...p,
      ...(n.usedPct !== undefined ? { usedPct: n.usedPct } : {}),
      ...(n.resetAt !== undefined ? { resetAt: n.resetAt } : {}),
      ...(n.observedAt !== undefined ? { observedAt: n.observedAt } : {}),
      ...(n.source !== undefined ? { source: n.source } : {}),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// pctRemaining
// ---------------------------------------------------------------------------

/**
 * Returns the percent of budget remaining for a window (0–100), or
 * `undefined` when `usedPct` is not known.
 *
 * Clamps the result to [0, 100] to guard against any out-of-range stored value.
 */
export function pctRemaining(window: UsageWindow | undefined): number | undefined {
  if (window?.usedPct === undefined) return undefined;
  const rem = 100 - window.usedPct;
  return Math.min(100, Math.max(0, rem));
}

// ---------------------------------------------------------------------------
// windowEndsInMs
// ---------------------------------------------------------------------------

/**
 * Returns milliseconds until the window resets (clamped to >= 0), or
 * `undefined` when `resetAt` is absent or not a valid ISO timestamp.
 *
 * @param now Injected clock; defaults to `new Date()`.
 */
export function windowEndsInMs(
  window: UsageWindow | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!window?.resetAt) return undefined;
  const resetMs = new Date(window.resetAt).getTime();
  if (Number.isNaN(resetMs)) return undefined;
  return Math.max(0, resetMs - now.getTime());
}

// ---------------------------------------------------------------------------
// windowEndsWithinMin
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the window's reset time is known and falls within
 * `minutes` minutes from `now`.
 *
 * @param now Injected clock; defaults to `new Date()`.
 */
export function windowEndsWithinMin(
  window: UsageWindow | undefined,
  minutes: number,
  now: Date = new Date(),
): boolean {
  const ms = windowEndsInMs(window, now);
  return ms !== undefined && ms <= minutes * 60_000;
}

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the observation is older than `maxAgeMs` (or missing).
 *
 * Use this before trusting a stored usage figure for routing decisions.
 *
 * @param now Injected clock; defaults to `new Date()`.
 */
export function isStale(
  window: UsageWindow | undefined,
  maxAgeMs: number,
  now: Date = new Date(),
): boolean {
  if (!window?.observedAt) return true;
  const observedMs = new Date(window.observedAt).getTime();
  if (Number.isNaN(observedMs)) return true;
  return now.getTime() - observedMs > maxAgeMs;
}

// ---------------------------------------------------------------------------
// formatBudget
// ---------------------------------------------------------------------------

/**
 * Returns a compact one-line human-readable summary of a {@link UsageBudget}.
 *
 * Format: `session 50% · weekly 80%`
 *
 * Windows with no data are omitted.  Returns `"—"` when nothing is known.
 * Plain text only — no ANSI colour codes.
 */
export function formatBudget(budget: UsageBudget | undefined): string {
  const parts: string[] = [];

  for (const key of ['session', 'weekly'] as const) {
    const w = budget?.[key];
    if (w === undefined) continue;
    if (w.usedPct !== undefined) {
      parts.push(`${key} ${w.usedPct}%`);
    } else if (w.resetAt !== undefined) {
      // At least we know the window exists, even if percentage is unknown
      parts.push(`${key} (reset known)`);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : '—';
}
