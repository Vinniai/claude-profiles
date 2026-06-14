/**
 * Pure builders for the "extra" Claude Code hooks claude-profiles wires up:
 *
 *  - UserPromptSubmit → a per-turn budget guardrail string injected as
 *    `additionalContext` when the active account is near/over its session cap.
 *  - Notification     → the payload forwarded to a configured webhook so the
 *    host CLI's "waiting for input / needs permission" pings reach your phone.
 *  - SubagentStop     → a routing-log entry recording a subagent completion so
 *    fleet/delegate work shows up in the routing history.
 *
 * Everything here is pure (no IO, no `Date.now()`), so the dispatch wiring in
 * commands/hook.ts can be a thin, swallow-everything shell around these.
 */

import type { CutoverInfo } from './cutover.js';
import type { NotifyConfig, RoutingEvent } from '../types/index.js';

/** Default headroom (percentage points to the cap) at which we start warning. */
export const DEFAULT_BUDGET_WARN_REMAINING_PCT = 10;

export interface BudgetGuardrailOpts {
  /** The active account's profile name. */
  profile: string;
  /** Cutover math for the active account (cap, used%, headroom, ETA). */
  cutover: CutoverInfo;
  /** Warn once headroom to the cap is at/below this many points (default 10). */
  warnAtRemainingPct?: number;
}

/**
 * Build the per-turn budget note to inject as `additionalContext`, or null when
 * there is nothing worth saying (no cap configured, usage unknown, or plenty of
 * headroom). Over-cap gets a distinct, more urgent message because the launcher
 * will switch accounts at the next turn boundary.
 */
export function buildBudgetGuardrail(opts: BudgetGuardrailOpts): string | null {
  const { profile, cutover } = opts;
  const warnAt = opts.warnAtRemainingPct ?? DEFAULT_BUDGET_WARN_REMAINING_PCT;

  // Need both a known cap and a known usage figure to say anything useful.
  if (cutover.usedPct == null || cutover.capPct == null) return null;

  const used = Math.round(cutover.usedPct);
  const cap = Math.round(cutover.capPct);

  if (cutover.overCap) {
    return (
      `⚠ Account "${profile}" is over its session cap (${used}% used ≥ ${cap}% cap). ` +
      `claude-profiles will switch to the next account at a turn boundary — wrap up ` +
      `cleanly so this conversation carries over.`
    );
  }

  const remaining = cutover.remainingPct;
  if (remaining == null || remaining > warnAt) return null;

  const eta: string[] = [];
  if (cutover.etaMin != null) eta.push(`~${cutover.etaMin} min`);
  if (cutover.etaTurns != null) {
    eta.push(`~${cutover.etaTurns} turn${cutover.etaTurns === 1 ? '' : 's'}`);
  }
  const etaPart = eta.length > 0 ? ` (${eta.join(' / ')} to cutover)` : '';

  return (
    `⚠ Account "${profile}" is at ${used}% of its session cap (${cap}%)${etaPart}. ` +
    `Approaching the cutover — expect an account switch soon.`
  );
}

export interface NotifyPayload {
  /** Discord/Slack/generic-compatible message body. */
  content: string;
}

/**
 * Format a Claude Code `Notification` message for an external webhook, prefixing
 * the active chain/profile so a phone push tells you *which* account is waiting.
 */
export function buildNotifyPayload(opts: {
  message: string;
  profile?: string | null;
  chain?: string | null;
}): NotifyPayload {
  const tag =
    opts.chain && opts.profile
      ? `${opts.chain}/${opts.profile}`
      : (opts.profile ?? opts.chain ?? null);
  const prefix = tag ? `[${tag}] ` : '';
  const msg = opts.message?.trim() || 'Claude Code notification';
  return { content: `🔔 ${prefix}${msg}` };
}

/**
 * Whether a notification should be forwarded: only when a webhook is configured,
 * and (if an `events` filter is set) only when the message matches one of its
 * substrings, case-insensitively.
 */
export function shouldForwardNotification(
  notify: NotifyConfig | undefined,
  message: string
): boolean {
  if (!notify?.webhookUrl) return false;
  const filters = notify.events;
  if (!filters || filters.length === 0) return true;
  const m = (message ?? '').toLowerCase();
  return filters.some((e) => m.includes(e.toLowerCase()));
}

/**
 * A routing-log entry recording that a subagent finished under the active
 * account. Not a route change (`from`/`to` are the same account) — an
 * informational marker so delegate/fleet work is visible in the history.
 */
export function buildSubagentEvent(opts: {
  profile: string | null;
  chain: string;
  reason?: string;
}): Omit<RoutingEvent, 'at'> {
  return {
    kind: 'subagent',
    chain: opts.chain,
    from: opts.profile ?? undefined,
    to: opts.profile ?? undefined,
    mode: 'interactive',
    reason: opts.reason ?? 'subagent completed',
  };
}
