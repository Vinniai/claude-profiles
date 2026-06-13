/**
 * Read account identity + plan tier straight from the Claude CLI's own state,
 * so users don't have to hand-set `--plan` and `chain status` can show whether
 * each profile is still logged in.
 *
 * Two sources, cheapest first:
 *
 *   1. `<configDir>/.claude.json` → the `oauthAccount` block. A plain file read,
 *      no process spawn. Carries the precise rate-limit tier, email, display
 *      name, and org — enough to derive the {@link PlanTier} exactly.
 *
 *   2. `claude auth status --json` (spawned with `CLAUDE_CONFIG_DIR=<dir>`). The
 *      authoritative "is this profile still logged in" check — it exits 0 when
 *      logged in, 1 when not, and prints `{ loggedIn, email, subscriptionType,
 *      … }`. Used by `chain status` to flag accounts that silently logged out.
 *
 * Everything here is best-effort: a missing file, malformed JSON, or absent
 * `claude` binary yields `undefined` rather than throwing — callers treat the
 * info as advisory.
 */

import { spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import type { PlanTier } from '../types/index.js';

/** Identity + plan info read from a profile's `oauthAccount` block. */
export interface AccountInfo {
  email?: string;
  displayName?: string;
  organizationName?: string;
  /** Raw Anthropic org type, e.g. `claude_max` / `claude_pro`. */
  organizationType?: string;
  /** Raw rate-limit tier, e.g. `default_claude_max_20x` / `default_claude_ai`. */
  rateLimitTier?: string;
  hasExtraUsageEnabled?: boolean;
  /** Our normalized tier, derived from the raw fields above. */
  plan?: PlanTier;
}

/** Result of `claude auth status --json`. */
export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  /** Coarse plan string Anthropic reports, e.g. `max` / `pro`. */
  subscriptionType?: string;
  authMethod?: string;
  orgName?: string;
}

/**
 * Map Anthropic's raw `organizationType` / rate-limit-tier strings onto our
 * normalized {@link PlanTier}. Returns `undefined` when nothing recognizable is
 * present.
 *
 * The rate-limit tier is the most specific signal (`…max_20x` vs `…max_5x`);
 * `organizationType` is the coarse fallback. A Max org whose exact multiplier we
 * can't read is treated as `max-5x` (the lower Max tier) rather than guessed
 * high, so routing never over-credits an account's headroom.
 */
export function planFromOauth(
  organizationType?: string,
  rateLimitTier?: string,
): PlanTier | undefined {
  const tier = (rateLimitTier ?? '').toLowerCase();
  const org = (organizationType ?? '').toLowerCase();

  if (tier.includes('max_20x') || tier.includes('max-20x')) return 'max-20x';
  if (tier.includes('max_5x') || tier.includes('max-5x')) return 'max-5x';
  // Pro accounts report the generic `default_claude_ai` tier.
  if (org.includes('pro') || tier.includes('claude_ai')) return 'pro';
  // Known Max org but unreadable multiplier → assume the lower Max tier.
  if (org.includes('max')) return 'max-5x';
  return undefined;
}

/**
 * Read `<configDir>/.claude.json` and extract the account identity + plan from
 * its `oauthAccount` block. Returns `undefined` if the file is missing, has no
 * `oauthAccount`, or can't be parsed. Never throws.
 */
export async function readAccountInfo(
  configDir: string,
): Promise<AccountInfo | undefined> {
  try {
    const file = path.join(configDir, '.claude.json');
    const raw = await fs.readFile(file, 'utf8');
    const json = JSON.parse(raw) as { oauthAccount?: Record<string, unknown> };
    const o = json.oauthAccount;
    if (!o || typeof o !== 'object') return undefined;

    const organizationType =
      typeof o.organizationType === 'string' ? o.organizationType : undefined;
    // Prefer a user-specific override, else the org default.
    const rateLimitTier =
      (typeof o.userRateLimitTier === 'string' && o.userRateLimitTier) ||
      (typeof o.organizationRateLimitTier === 'string'
        ? o.organizationRateLimitTier
        : undefined) ||
      undefined;

    return {
      email: typeof o.emailAddress === 'string' ? o.emailAddress : undefined,
      displayName: typeof o.displayName === 'string' ? o.displayName : undefined,
      organizationName:
        typeof o.organizationName === 'string' ? o.organizationName : undefined,
      organizationType,
      rateLimitTier,
      hasExtraUsageEnabled:
        typeof o.hasExtraUsageEnabled === 'boolean'
          ? o.hasExtraUsageEnabled
          : undefined,
      plan: planFromOauth(organizationType, rateLimitTier),
    };
  } catch {
    return undefined;
  }
}

/**
 * Run `claude auth status --json` against a profile's config dir to confirm it
 * is still logged in. Best-effort: resolves `undefined` if `claude` isn't on
 * PATH, the call times out, or the output isn't parseable.
 *
 * @param configDir  The profile's `CLAUDE_CONFIG_DIR`.
 * @param claudeBin  Override the `claude` binary (defaults to env / `claude`).
 * @param timeoutMs  Hard timeout; the child is killed past it (default 8s).
 */
export async function probeAuthStatus(
  configDir: string,
  claudeBin?: string,
  timeoutMs = 8000,
): Promise<AuthStatus | undefined> {
  const bin = claudeBin || process.env.CLAUDE_PROFILES_CLAUDE_BIN || 'claude';
  return new Promise<AuthStatus | undefined>((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (v: AuthStatus | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['auth', 'status', '--json'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      done(undefined);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(undefined);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(stdout) as Record<string, unknown>;
        done({
          loggedIn: json.loggedIn === true,
          email: typeof json.email === 'string' ? json.email : undefined,
          subscriptionType:
            typeof json.subscriptionType === 'string'
              ? json.subscriptionType
              : undefined,
          authMethod:
            typeof json.authMethod === 'string' ? json.authMethod : undefined,
          orgName: typeof json.orgName === 'string' ? json.orgName : undefined,
        });
      } catch {
        done(undefined);
      }
    });
  });
}
