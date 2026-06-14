/**
 * Classifies the result of a `claude` CLI invocation so the router can decide
 * whether to fall back to another profile.
 *
 * The Claude CLI does not expose machine-readable error categories for account
 * problems, so we inspect exit code + stdout/stderr text (and the JSON envelope
 * when `--output-format json` is used). Only three failure kinds trigger
 * failover — rate limits, transient server errors, and auth/expired tokens.
 */

export type FailureKind =
  | 'none'
  | 'rate_limit'
  | 'server_error'
  | 'auth'
  | 'other';

export interface ClaudeInvocationResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ClaudeOutcome {
  ok: boolean;
  kind: FailureKind;
  /** Best-effort parsed reset time for rate limits, if the CLI reported one. */
  resetAt: Date | null;
  /** Short human-readable reason for logs. */
  reason: string;
  /** The combined text that was classified (for debugging / state.lastError). */
  raw: string;
}

const RATE_LIMIT_PATTERNS = [
  /usage limit reached/i,
  /rate[\s_-]?limit/i,
  /rate_limit_error/i,
  /\b429\b/,
  /too many requests/i,
  /quota (?:exceeded|reached)/i,
  /reached your .{0,40}limit/i,
  /limit will reset/i,
];

const SERVER_ERROR_PATTERNS = [
  /\boverloaded\b/i,
  /overloaded_error/i,
  /\b529\b/,
  /\b50[0234]\b/,
  /internal server error/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /api_error/i,
];

const AUTH_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /authentication_error/i,
  /invalid[\s_-]?(?:api[\s_-]?key|credential|token|x-api-key)/i,
  /oauth token (?:has )?expired/i,
  /token (?:has )?expired/i,
  /(?:please|need to|run).{0,20}(?:\/?login|log in|sign in)/i,
  /not (?:logged in|authenticated)/i,
  /no (?:valid )?credentials/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Parse a reset time out of a rate-limit message. Handles a few shapes the CLI
 * / API surface in practice: an explicit unix `resetsAt`/`resets_at` epoch, or
 * a human "resets at 3:45pm" phrase. Returns null when nothing parseable.
 */
export function parseResetTime(text: string, now: Date): Date | null {
  // Unix epoch (seconds or ms), e.g. "resets_at": 1718200000
  const epochMatch = text.match(
    /["']?resets?_?at["']?\s*[:=]\s*["']?(\d{10,13})/i
  );
  if (epochMatch) {
    const num = Number(epochMatch[1]);
    const ms = num < 1e12 ? num * 1000 : num;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Human time, e.g. "resets at 3:45pm" or "resets at 15:00"
  const humanMatch = text.match(
    /resets?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i
  );
  if (humanMatch) {
    let hours = Number(humanMatch[1]);
    const minutes = humanMatch[2] ? Number(humanMatch[2]) : 0;
    const meridiem = humanMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      const d = new Date(now);
      d.setHours(hours, minutes, 0, 0);
      // If the parsed time already passed today, assume it's tomorrow.
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
  }

  return null;
}

/**
 * Pull the final JSON value out of `claude`'s stdout, handling all three output
 * shapes: a single `--output-format json` object, a JSON array, and
 * `--output-format stream-json` (NDJSON — one object per line, the last line
 * being the result envelope). Returns the last meaningful value, or null.
 */
function parseLastJsonValue(trimmed: string): unknown {
  // Single JSON value (object or array) — the common --output-format json case.
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  } catch {
    // Not one value — fall through to NDJSON (stream-json) line scanning.
  }
  let last: unknown = null;
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try {
      const v = JSON.parse(t);
      last = Array.isArray(v) ? v[v.length - 1] : v;
    } catch {
      // Skip a partial / non-JSON line; keep the last one that did parse.
    }
  }
  return last;
}

/**
 * When `claude --output-format json|stream-json` is used, pull the human message
 * + error flag out of the final envelope so we classify on the real error text
 * rather than the JSON punctuation.
 */
function extractJsonSignal(stdout: string): {
  isError: boolean;
  message: string;
} | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const obj = parseLastJsonValue(trimmed) as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') return null;
    const isError =
      obj.is_error === true ||
      obj.subtype === 'error' ||
      obj.type === 'error' ||
      typeof obj.error !== 'undefined';
    const errObj =
      obj.error && typeof obj.error === 'object'
        ? (obj.error as Record<string, unknown>)
        : undefined;
    const message = [
      obj.result,
      obj.message,
      typeof obj.error === 'string' ? obj.error : errObj?.message,
      errObj?.type,
    ]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    return { isError, message };
  } catch {
    return null;
  }
}

/**
 * Classify a finished `claude` invocation.
 *
 * @param now Injected for deterministic tests; defaults to `new Date()`.
 */
export function classifyOutcome(
  result: ClaudeInvocationResult,
  now: Date = new Date()
): ClaudeOutcome {
  const json = extractJsonSignal(result.stdout);
  const raw = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const haystack = json ? `${json.message}\n${result.stderr}` : raw;

  const succeeded =
    result.exitCode === 0 && !(json && json.isError);

  // A clean success short-circuits — never inspect text for a passing run.
  if (succeeded) {
    return { ok: true, kind: 'none', resetAt: null, reason: 'ok', raw };
  }

  // Order matters: auth and rate limits are more specific than server errors.
  if (matchesAny(haystack, RATE_LIMIT_PATTERNS)) {
    return {
      ok: false,
      kind: 'rate_limit',
      resetAt: parseResetTime(haystack, now),
      reason: 'usage/rate limit reached',
      raw,
    };
  }

  if (matchesAny(haystack, AUTH_PATTERNS)) {
    return {
      ok: false,
      kind: 'auth',
      resetAt: null,
      reason: 'authentication/expired token',
      raw,
    };
  }

  if (matchesAny(haystack, SERVER_ERROR_PATTERNS)) {
    return {
      ok: false,
      kind: 'server_error',
      resetAt: null,
      reason: 'server/overloaded error',
      raw,
    };
  }

  return {
    ok: false,
    kind: 'other',
    resetAt: null,
    reason: 'command failed',
    raw,
  };
}

/** The failure kinds that should trigger fallback to the next profile. */
export const FAILOVER_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'rate_limit',
  'server_error',
  'auth',
]);

export function shouldFailover(kind: FailureKind): boolean {
  return FAILOVER_KINDS.has(kind);
}
