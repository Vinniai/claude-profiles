import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

/**
 * A single parsed profile token. `weight` carries an inline split — both the
 * ratio form (`josh:3`) and the percentage form (`josh=50`) land here as a
 * positive number, because the `weighted` strategy normalises by total either
 * way (`3:1` and `75=25` describe the same distribution).
 */
export interface ProfileToken {
  name: string;
  weight?: number;
}

const TOKEN_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:([:=])(.+))?$/;

/**
 * Parse one CLI token into a profile reference, or return `null` when it does
 * not look like a profile token at all (so the caller can stop collecting).
 * Throws only when a token clearly *intends* a weight but the value is invalid.
 */
export function parseProfileToken(token: string): ProfileToken | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const [, name, sep, rawValue] = m;
  if (!sep) return { name };

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ClaudeProfilesError(
      `Invalid weight for "${name}": "${rawValue}"`,
      ErrorCode.INVALID_CONFIG,
      'Use a positive number, e.g. `josh:3` (ratio) or `josh=50` (percent).'
    );
  }
  return { name, weight: value };
}

export interface ParsedProfilesSpec {
  /** Ordered, de-duplicated profile names. */
  names: string[];
  /** Per-name weight overrides, only for tokens that carried one. */
  weights: Record<string, number>;
  /** True when at least one token carried an inline weight/split. */
  hasWeights: boolean;
}

/**
 * Parse a comma-separated `--profiles` spec like `josh:3,lockie:1` or
 * `a,b,c` into an ordered name list plus any inline weights.
 */
export function parseProfilesSpec(spec: string): ParsedProfilesSpec {
  const items = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const names: string[] = [];
  const weights: Record<string, number> = {};
  let hasWeights = false;

  for (const item of items) {
    const token = parseProfileToken(item);
    if (!token) {
      throw new ClaudeProfilesError(
        `Invalid profile token: "${item}"`,
        ErrorCode.INVALID_CONFIG,
        'Expected `name`, `name:weight`, or `name=percent`.'
      );
    }
    if (names.includes(token.name)) {
      throw new ClaudeProfilesError(
        `Profile "${token.name}" listed more than once`,
        ErrorCode.INVALID_CONFIG
      );
    }
    names.push(token.name);
    if (token.weight != null) {
      weights[token.name] = token.weight;
      hasWeights = true;
    }
  }

  return { names, weights, hasWeights };
}
