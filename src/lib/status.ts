import type { ProfileConfig, RuntimeStateFile } from '../types/index.js';
import { isHealthy, cooldownRemainingMs } from './state.js';
import { effectivePolicy, upNextForChain } from './router.js';
import { computeCutover, computeDrain, computeSchedule } from './cutover.js';
import { computeAccountPace } from './pace.js';
import { probeAuthStatus, readAccountInfo } from './account-info.js';
import type { StatusRow } from './render.js';

/** "8m" / "2h10m" — compact remaining-cooldown label. */
function formatRemaining(ms: number): string {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

export interface BuildStatusRowsOptions {
  /** Skip the live `claude auth status` probe (don't spawn claude). */
  offline?: boolean;
  /** Chain context for cap / cutover / up-next computation. */
  chain?: string;
  now?: Date;
}

/**
 * Build the per-profile status rows shared by `chain status` and the no-arg
 * landing screen. Computes health, identity (live or cached), session/weekly
 * budgets, cutover countdowns, and which profile routing would pick next.
 *
 * With `offline: true` it never spawns `claude` — identity falls back to the
 * saved config / cached account info, making it safe for an instant dashboard.
 */
export async function buildStatusRows(
  config: ProfileConfig,
  state: RuntimeStateFile,
  options: BuildStatusRowsOptions = {}
): Promise<StatusRow[]> {
  const now = options.now ?? new Date();
  const names = Object.keys(config.profiles);
  if (names.length === 0) return [];

  // Cutover context: explicit chain wins, then the launched-session env, then a
  // chain literally named "default".
  const chain =
    options.chain ||
    process.env.CLAUDE_PROFILES_CHAIN ||
    (config.chains?.default ? 'default' : undefined);
  const next = await upNextForChain({ config, chain, now });

  // Live login truth, probed concurrently. Best-effort — a failed probe simply
  // omits the account line. `offline` skips the spawn entirely.
  const live = new Map<
    string,
    { login?: 'in' | 'out'; email?: string; subscriptionType?: string }
  >();
  if (!options.offline) {
    await Promise.all(
      names.map(async (name) => {
        const auth = await probeAuthStatus(config.profiles[name].configDir);
        if (auth) {
          live.set(name, {
            login: auth.loggedIn ? 'in' : 'out',
            email: auth.email,
            subscriptionType: auth.subscriptionType,
          });
        }
      })
    );
  }

  return Promise.all(
    names.map(async (name) => {
      const s = state.profiles[name];
      const profile = config.profiles[name];
      const probe = live.get(name);
      let status: StatusRow['status'] = 'healthy';
      let detail: string | undefined;
      if (s && !isHealthy(s, now)) {
        if (s.needsAuth) {
          status = 'auth';
          detail = `run: claude-profiles login ${name}`;
        } else {
          status = 'cooling';
          const remaining = cooldownRemainingMs(s, now);
          detail = remaining
            ? `${formatRemaining(remaining)} left${s.lastError ? ` — ${s.lastError}` : ''}`
            : s.lastError;
        }
      }
      // A live "logged out" is authoritative — surface it even if runtime state
      // hasn't recorded an auth failure yet.
      if (probe?.login === 'out' && status === 'healthy') {
        status = 'auth';
        detail = `run: claude-profiles login ${name}`;
      }

      // Fall back to the saved config's identity when we didn't probe live.
      const info = probe ? undefined : await readAccountInfo(profile.configDir);
      const email = probe?.email ?? info?.email;
      const plan = profile.plan ?? info?.plan;

      const policy = effectivePolicy(config, chain, name);
      const cutover = computeCutover({
        session: s?.usage?.session,
        policy,
        override: s?.capOverride,
        burn: s?.burn,
        now,
      });
      const drain = computeDrain({
        session: s?.usage?.session,
        weekly: s?.usage?.weekly,
        policy,
        now,
      });
      const schedule = computeSchedule({ policy, now });

      // Efficiency read-out: burn-rate session pace + position-in-window weekly
      // pace, against the same effective cap routing uses for cutover.
      const pace = computeAccountPace({
        name,
        session: s?.usage?.session,
        weekly: s?.usage?.weekly,
        capPct: cutover.capPct ?? undefined,
        burnPctPerMin: s?.burn?.sessionPctPerMin,
        now,
      });

      return {
        name,
        status,
        detail,
        description: profile.description,
        kind: status === 'healthy' ? undefined : s?.lastEventKind,
        session: s?.usage?.session,
        weekly: s?.usage?.weekly,
        login: probe?.login,
        email,
        plan,
        cutover,
        drain,
        schedule,
        pace,
        upNext: next?.name === name,
      } satisfies StatusRow;
    })
  );
}
