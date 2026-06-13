/**
 * Authoritative usage limits, straight from Anthropic's own signals.
 *
 * Unlike `usage-transcripts.ts` (which sums tokens — a retrospective estimate)
 * and `usage.ts#parseUsageFromText` (best-effort scraping of human-facing
 * messages), this module reads the *server-authoritative* limit state that the
 * official client itself uses:
 *
 *  1. **Response headers** — every `POST /v1/messages` comes back with an
 *     `anthropic-ratelimit-unified-*` block giving live 5h (session) and 7d
 *     (weekly) utilization fractions and reset epochs. We scrape these from a
 *     run captured with `ANTHROPIC_LOG=debug` (see router.ts). Zero extra cost —
 *     it piggybacks on a call you were already making.
 *
 *  2. **`GET /api/oauth/usage`** — a token-free, usage-free endpoint that reports
 *     the same limits on demand, for accounts you haven't run recently. Used by
 *     `chain status --refresh`.
 *
 * Both map onto the existing {@link UsageBudget} shape, so the strategy layer
 * (`most-remaining` / `least-used` / policy gates) consumes them unchanged.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import type { UsageBudget, UsageWindow } from '../types/index.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 1. Response-header parsing (CONFIRMED against a live capture)
// ---------------------------------------------------------------------------

/**
 * Extra, display-only fields carried by the unified rate-limit headers that
 * don't fit the routing-focused {@link UsageBudget} shape.
 */
export interface RateLimitDetail {
  /** Overall standing: `allowed` | `allowed_warning` | `rejected`. */
  status?: string;
  /** Which window is currently binding, e.g. `five_hour` / `seven_day`. */
  representativeClaim?: string;
  /** Overage standing, e.g. `rejected` when extra usage is disabled. */
  overageStatus?: string;
}

/** Convert a unix epoch (seconds or millis) to an ISO string, or undefined. */
function epochToIso(raw: string | number | undefined): string | undefined {
  if (raw == null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // 10-digit values are seconds; 13-digit are milliseconds.
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Pull the first capture group for a unified-ratelimit key from debug text. */
function matchHeader(text: string, key: string): string | undefined {
  // Tolerates both JSON (`"key": "val"`) and header (`key: val`) renderings.
  const re = new RegExp(
    `anthropic-ratelimit-unified-${key}"?\\s*[:=]\\s*"?([^"\\s,}]+)`,
    'i',
  );
  const m = text.match(re);
  return m ? m[1] : undefined;
}

/**
 * Parse the `anthropic-ratelimit-unified-*` block out of captured debug output
 * (e.g. `ANTHROPIC_LOG=debug` stderr) into a {@link UsageBudget}. Returns
 * `undefined` if no recognizable utilization figure is present. Never throws.
 *
 * Header → window mapping:
 *   `5h-utilization` (0–1)  → session.usedPct (0–100)
 *   `5h-reset` (epoch)      → session.resetAt
 *   `7d-utilization` (0–1)  → weekly.usedPct
 *   `7d-reset` (epoch)      → weekly.resetAt
 */
export function parseUnifiedRateLimits(
  text: string,
  now: Date = new Date(),
): UsageBudget | undefined {
  if (!text || text.indexOf('anthropic-ratelimit-unified') === -1) return undefined;
  const observedAt = now.toISOString();

  function windowFor(prefix: '5h' | '7d'): UsageWindow | undefined {
    const util = matchHeader(text, `${prefix}-utilization`);
    const reset = matchHeader(text, `${prefix}-reset`);
    if (util == null && reset == null) return undefined;
    const window: UsageWindow = { observedAt, source: 'observed' };
    if (util != null) {
      const frac = Number(util);
      if (Number.isFinite(frac)) window.usedPct = Math.round(frac * 100);
    }
    const iso = epochToIso(reset);
    if (iso) window.resetAt = iso;
    // A window with neither a usable pct nor a reset is not worth recording.
    if (window.usedPct == null && window.resetAt == null) return undefined;
    return window;
  }

  const session = windowFor('5h');
  const weekly = windowFor('7d');
  if (!session && !weekly) return undefined;

  const budget: UsageBudget = {};
  if (session) budget.session = session;
  if (weekly) budget.weekly = weekly;
  return budget;
}

/** Parse the display-only standing fields from the same header block. */
export function parseRateLimitDetail(text: string): RateLimitDetail | undefined {
  if (!text || text.indexOf('anthropic-ratelimit-unified') === -1) return undefined;
  const detail: RateLimitDetail = {
    status: matchHeader(text, 'status'),
    representativeClaim: matchHeader(text, 'representative-claim'),
    overageStatus: matchHeader(text, 'overage-status'),
  };
  if (!detail.status && !detail.representativeClaim && !detail.overageStatus) {
    return undefined;
  }
  return detail;
}

// ---------------------------------------------------------------------------
// 2. Token-free GET /api/oauth/usage
// ---------------------------------------------------------------------------

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
/** OAuth beta header the official client sends on OAuth-scoped requests. */
const OAUTH_BETA = 'oauth-2025-04-20';
/** macOS Keychain service the Claude CLI stores its credentials under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Resolve a profile's Claude OAuth access token. Tries the per-profile
 * `.credentials.json` first (Linux/headless storage), then falls back to the
 * macOS Keychain (the CLI's default on darwin). Returns undefined if neither
 * yields a token. Never throws.
 */
export async function readOAuthToken(
  configDir: string,
): Promise<string | undefined> {
  // 1. File-based credentials (`claudeAiOauth.accessToken`).
  try {
    const creds = await fs.readJson(path.join(configDir, '.credentials.json'));
    const tok = creds?.claudeAiOauth?.accessToken;
    if (typeof tok === 'string' && tok.length > 20) return tok;
  } catch {
    /* fall through to keychain */
  }

  // 2. macOS Keychain. The CLI stores the credentials JSON (or bare token)
  //    under a generic-password item; read it the same way the CLI does.
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: 10_000 },
      );
      const raw = stdout.trim();
      if (raw) {
        try {
          const obj = JSON.parse(raw);
          const tok = obj?.claudeAiOauth?.accessToken ?? obj?.accessToken;
          if (typeof tok === 'string' && tok.length > 20) return tok;
        } catch {
          if (raw.length > 20) return raw;
        }
      }
    } catch {
      /* no keychain item / security unavailable */
    }
  }
  return undefined;
}

/**
 * Map a `GET /api/oauth/usage` JSON body to a {@link UsageBudget}.
 *
 * NOTE: tolerant by design — the exact field names are being confirmed against
 * a live response. It probes a few likely shapes (a `five_hour`/`seven_day`
 * object, or `*_5h`/`*_7d` keys) for a 0–1 `utilization`/`used` fraction and a
 * `resets_at`/`reset` epoch, and degrades gracefully when a field is absent.
 */
export function usageBudgetFromApiBody(
  body: unknown,
  now: Date = new Date(),
): UsageBudget | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const observedAt = now.toISOString();
  const root = body as Record<string, unknown>;

  function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
        return Number(v);
      }
    }
    return undefined;
  }

  function windowFrom(node: unknown): UsageWindow | undefined {
    if (!node || typeof node !== 'object') return undefined;
    const o = node as Record<string, unknown>;
    const frac = pickNumber(o, ['utilization', 'used', 'used_fraction', 'usage']);
    const pct = pickNumber(o, ['used_pct', 'usedPct', 'percent_used', 'percentUsed']);
    const reset = pickNumber(o, ['resets_at', 'reset_at', 'reset', 'resetsAt']);
    const window: UsageWindow = { observedAt, source: 'observed' };
    if (pct != null) window.usedPct = Math.round(pct);
    else if (frac != null) window.usedPct = Math.round(frac * 100);
    const iso = epochToIso(reset);
    if (iso) window.resetAt = iso;
    if (window.usedPct == null && window.resetAt == null) return undefined;
    return window;
  }

  // Try a nested-object shape first, then flat sibling keys.
  const session =
    windowFrom(root.five_hour ?? root.fiveHour ?? root.session ?? root['5h']) ??
    windowFrom({
      utilization: root.five_hour_utilization,
      resets_at: root.five_hour_resets_at,
    });
  const weekly =
    windowFrom(root.seven_day ?? root.sevenDay ?? root.weekly ?? root['7d']) ??
    windowFrom({
      utilization: root.seven_day_utilization,
      resets_at: root.seven_day_resets_at,
    });

  if (!session && !weekly) return undefined;
  const budget: UsageBudget = {};
  if (session) budget.session = session;
  if (weekly) budget.weekly = weekly;
  return budget;
}

export interface FetchUsageOptions {
  now?: Date;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetch a profile's live usage budget via the token-free `GET /api/oauth/usage`
 * endpoint. Sends no prompt and consumes no token budget. Returns undefined if
 * the token can't be resolved or the request fails. Never throws.
 */
export async function fetchUsageSnapshot(
  configDir: string,
  opts: FetchUsageOptions = {},
): Promise<UsageBudget | undefined> {
  const token = await readOAuthToken(configDir);
  if (!token) return undefined;

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
      },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const body = await res.json();
    return usageBudgetFromApiBody(body, opts.now);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
