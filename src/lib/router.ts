import { spawn } from 'child_process';
import {
  ClaudeProfilesError,
  ErrorCode,
  planCapacity,
  type Profile,
  type ProfileConfig,
  type RoutingEventKind,
  type RoutingPolicy,
  type RoutingStrategy,
  type RuntimeStateFile,
  type UsageBudget,
} from '../types/index.js';
import {
  classifyOutcome,
  shouldFailover,
  type ClaudeOutcome,
} from './claude-errors.js';
import {
  cooldownRemainingMs,
  isHealthy,
  loadState,
  markNeedsAuth,
  setProfileCooldown,
} from './state.js';
import {
  applyRouting,
  resolveStrategy,
  type RoutableCandidate,
} from './strategy.js';

/** Cooldown applied when no explicit reset time is available. */
export const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
export const SERVER_ERROR_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

/** Override the claude binary (used by e2e tests to inject a mock). */
function claudeBin(): string {
  return process.env.CLAUDE_PROFILES_CLAUDE_BIN || 'claude';
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn factory injected for tests; defaults to the real capturing spawn. */
export type CaptureSpawn = (
  configDir: string,
  args: string[]
) => Promise<SpawnResult>;

/**
 * Headless spawn: inherit stdin (so piped prompts work), capture stdout/stderr
 * so we can classify the result and only surface output on success.
 */
export const captureSpawn: CaptureSpawn = (configDir, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new ClaudeProfilesError(
            `Could not find the "${claudeBin()}" CLI on your PATH`,
            ErrorCode.CLAUDE_NOT_FOUND,
            'Install Claude Code, or set CLAUDE_PROFILES_CLAUDE_BIN to its path.'
          )
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
  });

export interface Candidate {
  name: string;
  profile: Profile;
  healthy: boolean;
  /** Last-known usage budget, surfaced for the transition/status UI. */
  usage?: UsageBudget;
}

/**
 * Merge the effective routing policy for a profile: global config policy, then
 * the per-chain policy, then the profile's own policy (most specific wins).
 */
export function effectivePolicy(
  config: ProfileConfig,
  chainName: string | undefined,
  profileName: string
): RoutingPolicy | undefined {
  const merged: RoutingPolicy = {
    ...config.routing?.policy,
    ...(chainName ? config.chainRouting?.[chainName]?.policy : undefined),
    ...config.profiles[profileName]?.policy,
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Resolve the ordered list of profile names to try, given a `--chain`,
 * `--profile`, or neither (default chain, else all profiles by priority).
 */
export function resolveProfileNames(
  config: ProfileConfig,
  opts: { chain?: string; profile?: string; profiles?: string[] }
): string[] {
  if (opts.profile) {
    if (!config.profiles[opts.profile]) {
      throw new ClaudeProfilesError(
        `Profile "${opts.profile}" not found`,
        ErrorCode.NOT_INITIALIZED,
        `Use 'claude-profiles profile list' to see existing profiles.`
      );
    }
    return [opts.profile];
  }

  // Ad-hoc, ordered chain assembled on the command line (no saved chain). Every
  // name must exist; an unknown one is a typo we should surface, not swallow.
  if (opts.profiles && opts.profiles.length > 0) {
    const unknown = opts.profiles.filter((n) => !config.profiles[n]);
    if (unknown.length > 0) {
      throw new ClaudeProfilesError(
        `Unknown profile${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
        ErrorCode.NOT_INITIALIZED,
        `Use 'claude-profiles profile list' to see existing profiles.`
      );
    }
    return [...opts.profiles];
  }

  if (opts.chain) {
    const chain = config.chains?.[opts.chain];
    if (!chain || chain.length === 0) {
      throw new ClaudeProfilesError(
        `Chain "${opts.chain}" not found or empty`,
        ErrorCode.NO_CHAIN,
        `Create it with 'claude-profiles chain create ${opts.chain} --profiles a,b,c'.`
      );
    }
    return chain.filter((n) => config.profiles[n]);
  }

  // No explicit selection: prefer a chain literally named "default", else all
  // profiles in implicit order. Explicit `priority` wins; otherwise we fall back
  // to "big-first" (highest plan capacity first), so the account with the most
  // headroom leads and the smallest plan becomes the last-resort backstop.
  const defaultChain = config.chains?.default;
  if (defaultChain && defaultChain.length > 0) {
    return defaultChain.filter((n) => config.profiles[n]);
  }

  const sortKey = (name: string): number => {
    const p = config.profiles[name];
    // Explicit priority (small = first) wins; otherwise derive from capacity so
    // a higher-capacity plan sorts earlier (20× → 980, 5× → 995, pro → 999).
    return p.priority ?? 1000 - planCapacity(p.plan);
  };
  return Object.keys(config.profiles).sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka === kb ? a.localeCompare(b) : ka - kb;
  });
}

/**
 * Order candidates so healthy profiles (in their resolved order) come first,
 * followed by cooled-down ones sorted by soonest availability. We never drop
 * cooled-down profiles entirely — a limit may have reset since it was recorded.
 */
export function orderCandidates(
  names: string[],
  config: ProfileConfig,
  state: RuntimeStateFile,
  now: Date = new Date()
): Candidate[] {
  const annotated = names
    .filter((n) => config.profiles[n])
    .map((name) => ({
      name,
      profile: config.profiles[name],
      healthy: isHealthy(state.profiles[name], now),
    }));

  const healthy = annotated.filter((c) => c.healthy);
  const cooled = annotated
    .filter((c) => !c.healthy)
    .sort((a, b) => {
      const ra = cooldownRemainingMs(state.profiles[a.name], now) ?? Infinity;
      const rb = cooldownRemainingMs(state.profiles[b.name], now) ?? Infinity;
      return ra - rb;
    });

  return [...healthy, ...cooled];
}

/** Record the appropriate cooldown / needs-auth flag for a failed attempt. */
async function recordFailure(
  name: string,
  outcome: ClaudeOutcome,
  now: Date = new Date()
): Promise<void> {
  if (outcome.kind === 'auth') {
    await markNeedsAuth(name, outcome.reason, now);
    return;
  }
  if (outcome.kind === 'rate_limit') {
    const until =
      outcome.resetAt && outcome.resetAt.getTime() > now.getTime()
        ? outcome.resetAt
        : new Date(now.getTime() + RATE_LIMIT_COOLDOWN_MS);
    await setProfileCooldown(name, until, outcome.reason, now, 'limit');
    return;
  }
  if (outcome.kind === 'server_error') {
    await setProfileCooldown(
      name,
      new Date(now.getTime() + SERVER_ERROR_COOLDOWN_MS),
      outcome.reason,
      now,
      'server'
    );
  }
}

export interface FallbackAttempt {
  name: string;
  outcome: ClaudeOutcome;
}

export interface FallbackResult {
  /** The profile that ultimately succeeded, or null if all were exhausted. */
  succeeded: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
  attempts: FallbackAttempt[];
}

export interface RunWithFallbackOptions {
  candidates: Candidate[];
  claudeArgs: string[];
  spawnImpl?: CaptureSpawn;
  onAttempt?: (name: string, index: number, total: number) => void;
  onFallback?: (
    name: string,
    reason: string,
    next: string | null,
    kind: RoutingEventKind
  ) => void;
  now?: () => Date;
}

/** Map a failure classification to the routing-log event kind. */
export function failureEventKind(kind: ClaudeOutcome['kind']): RoutingEventKind {
  if (kind === 'rate_limit') return 'limit';
  if (kind === 'server_error') return 'server';
  if (kind === 'auth') return 'auth';
  return 'limit';
}

/**
 * Headless failover loop: try each candidate in order. On a failover-eligible
 * failure (rate limit / server / auth) record a cooldown and continue; on a
 * non-failover failure surface it immediately; on success forward output.
 */
export async function runWithFallback(
  opts: RunWithFallbackOptions
): Promise<FallbackResult> {
  const {
    candidates,
    claudeArgs,
    spawnImpl = captureSpawn,
    onAttempt,
    onFallback,
    now = () => new Date(),
  } = opts;

  if (candidates.length === 0) {
    throw new ClaudeProfilesError(
      'No profiles available to run',
      ErrorCode.ALL_PROFILES_EXHAUSTED,
      `Create a profile with 'claude-profiles profile create <name>'.`
    );
  }

  const attempts: FallbackAttempt[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    onAttempt?.(c.name, i, candidates.length);

    const result = await spawnImpl(c.profile.configDir, claudeArgs);
    const outcome = classifyOutcome(result, now());
    attempts.push({ name: c.name, outcome });

    if (outcome.ok) {
      return {
        succeeded: c.name,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        attempts,
      };
    }

    if (shouldFailover(outcome.kind)) {
      await recordFailure(c.name, outcome, now());
      const next = candidates[i + 1]?.name ?? null;
      onFallback?.(c.name, outcome.reason, next, failureEventKind(outcome.kind));
      continue;
    }

    // Non-failover failure (a real error / crash): surface it, do not reroute.
    return {
      succeeded: null,
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      attempts,
    };
  }

  // Every candidate failed with a failover-eligible error.
  const summary = attempts
    .map((a) => `  ${a.name}: ${a.outcome.reason}`)
    .join('\n');
  throw new ClaudeProfilesError(
    `All ${candidates.length} profile(s) were exhausted:\n${summary}`,
    ErrorCode.ALL_PROFILES_EXHAUSTED,
    `Check 'claude-profiles chain status', or wait for limits to reset.`
  );
}

/**
 * Interactive launch: hand the terminal directly to `claude` for the chosen
 * profile (no mid-session reroute is possible for a long-lived TUI). Resolves
 * with the child's exit code; forwards SIGINT/SIGTERM.
 */
export function runInteractive(
  candidate: Candidate,
  claudeArgs: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), claudeArgs, {
      env: { ...env, CLAUDE_CONFIG_DIR: candidate.profile.configDir },
      stdio: 'inherit',
    });

    const forward = (sig: NodeJS.Signals) => child.kill(sig);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    child.on('error', (err: NodeJS.ErrnoException) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (err.code === 'ENOENT') {
        reject(
          new ClaudeProfilesError(
            `Could not find the "${claudeBin()}" CLI on your PATH`,
            ErrorCode.CLAUDE_NOT_FOUND,
            'Install Claude Code, or set CLAUDE_PROFILES_CLAUDE_BIN to its path.'
          )
        );
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? 0);
    });
  });
}

export interface InteractiveFailoverOptions {
  candidates: Candidate[];
  claudeArgs: string[];
  /** Chain name + thread id threaded into the child env for the hooks. */
  chain?: string;
  threadId?: string;
  /** Re-check a profile's health after the child exits (defaults to state). */
  isCooledDown?: (name: string, now: Date) => Promise<boolean>;
  spawnInteractive?: (
    candidate: Candidate,
    claudeArgs: string[],
    env: NodeJS.ProcessEnv
  ) => Promise<number>;
  onLaunch?: (name: string, healthy: boolean) => void;
  onRelaunch?: (
    from: string,
    to: string,
    kind: RoutingEventKind,
    reason?: string
  ) => void;
  now?: () => Date;
}

export interface InteractiveResult {
  /** Profile whose session the user ultimately ended in. */
  lastProfile: string;
  exitCode: number;
  /** Profiles we relaunched through, in order. */
  path: string[];
}

/** Did this profile get marked unhealthy (cooled down / needs-auth) since launch? */
async function defaultIsCooledDown(name: string, now: Date): Promise<boolean> {
  const state = await loadState();
  return !isHealthy(state.profiles[name], now);
}

/**
 * Interactive launch with supervised, boundary-level failover. We launch the
 * first healthy candidate; a long-lived TUI can't be swapped mid-conversation,
 * so when `claude` exits we check whether the active profile was marked
 * cooled-down during the session (by the Stop/SessionEnd hook). If so — and a
 * healthy candidate remains — we relaunch on it; the SessionStart hook restores
 * context. A clean exit (profile still healthy) ends the loop.
 */
export async function runInteractiveWithFailover(
  opts: InteractiveFailoverOptions
): Promise<InteractiveResult> {
  const {
    candidates,
    claudeArgs,
    chain,
    threadId,
    isCooledDown = defaultIsCooledDown,
    spawnInteractive = (candidate, args, env) =>
      runInteractive(candidate, args, env),
    onLaunch,
    onRelaunch,
    now = () => new Date(),
  } = opts;

  if (candidates.length === 0) {
    throw new ClaudeProfilesError(
      'No profiles available to run',
      ErrorCode.ALL_PROFILES_EXHAUSTED,
      `Create a profile with 'claude-profiles profile create <name>'.`
    );
  }

  const path: string[] = [];
  const tried = new Set<string>();
  let current: Candidate | undefined = candidates[0];
  let exitCode = 0;

  while (current) {
    tried.add(current.name);
    path.push(current.name);
    onLaunch?.(current.name, current.healthy);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (chain) env.CLAUDE_PROFILES_CHAIN = chain;
    if (threadId) env.CLAUDE_PROFILES_THREAD = threadId;
    env.CLAUDE_PROFILES_RUN = '1';

    exitCode = await spawnInteractive(current, claudeArgs, env);

    // If the active profile is still healthy, this was a normal exit — stop.
    if (!(await isCooledDown(current.name, now()))) break;

    // The profile was throttled mid-session: relaunch on the next healthy,
    // not-yet-tried candidate (context is restored by the SessionStart hook).
    const next = candidates.find((c) => !tried.has(c.name) && c.healthy);
    if (!next) break;
    // Surface *why* it was retired so the caller can label the move (a manual
    // switch reads differently from an automatic limit/auth/server failover).
    const st = await loadState();
    const retired = st.profiles[current.name];
    onRelaunch?.(
      current.name,
      next.name,
      retired?.lastEventKind ?? 'limit',
      retired?.lastError
    );
    current = next;
  }

  return { lastProfile: path[path.length - 1], exitCode, path };
}

export interface DeferredCandidate {
  name: string;
  reasons: string[];
}

export interface BuildCandidatesResult {
  candidates: Candidate[];
  /** Healthy profiles pushed to the back because they failed a policy gate. */
  deferred: DeferredCandidate[];
  /** The routing strategy that ordered the healthy group. */
  strategy: RoutingStrategy;
}

/**
 * Load config + state and produce the ordered candidate list, applying the
 * configured routing strategy and eligibility policy.
 *
 * Ordering: the *healthy* group is ordered by the strategy (priority by
 * default), with policy-deferred profiles moved to the back of that group;
 * cooled-down / needs-auth profiles always come last, soonest-available first
 * (a limit may have reset). Nothing is ever dropped — a chain must always be
 * runnable.
 */
export interface BuildCandidatesOptions {
  chain?: string;
  profile?: string;
  /** Ad-hoc, ordered profile list assembled on the CLI (no saved chain). */
  profiles?: string[];
  /** Per-profile weight overrides (e.g. parsed from `josh:3 lockie:1`). */
  weights?: Record<string, number>;
  /** One-shot strategy override (a `--balanced`/`--weighted` flag), beats config. */
  strategyOverride?: RoutingStrategy;
  /** One-shot policy gates merged on top of the configured policy. */
  policyOverride?: RoutingPolicy;
  /**
   * Pin this profile to the front of the healthy group if it is healthy —
   * "sticky session": a continuation stays on the account it started on
   * (surviving compaction) regardless of the load-spreading strategy.
   */
  stickTo?: string;
}

export async function buildCandidates(
  config: ProfileConfig,
  opts: BuildCandidatesOptions,
  now: Date = new Date()
): Promise<BuildCandidatesResult> {
  const names = resolveProfileNames(config, opts);
  const state = await loadState();

  const resolved = resolveStrategy(
    config.routing,
    opts.chain ? config.chainRouting?.[opts.chain] : undefined
  );
  const strategy = opts.strategyOverride ?? resolved.strategy;

  const mergePolicy = (base?: RoutingPolicy): RoutingPolicy | undefined => {
    const merged = { ...base, ...opts.policyOverride };
    return Object.keys(merged).length > 0 ? merged : undefined;
  };

  const annotated = names
    .filter((n) => config.profiles[n])
    .map((name, index) => {
      const s = state.profiles[name];
      const p = config.profiles[name];
      return {
        name,
        profile: p,
        healthy: isHealthy(s, now),
        usage: s?.usage,
        lastUsedAt: s?.lastUsedAt,
        weight: opts.weights?.[name] ?? p.weight,
        capacity: planCapacity(p.plan),
        policy: mergePolicy(effectivePolicy(config, opts.chain, name)),
        priorityIndex: index,
      };
    });

  const byName = new Map(annotated.map((a) => [a.name, a]));
  const toCandidate = (name: string): Candidate => {
    const a = byName.get(name)!;
    return { name: a.name, profile: a.profile, healthy: a.healthy, usage: a.usage };
  };

  // Strategy + eligibility govern only the healthy group; cooled profiles keep
  // their soonest-availability ordering as a reliable last resort.
  const healthyRoutable: RoutableCandidate[] = annotated
    .filter((a) => a.healthy)
    .map((a) => ({
      name: a.name,
      healthy: true,
      priorityIndex: a.priorityIndex,
      weight: a.weight,
      capacity: a.capacity,
      usage: a.usage,
      lastUsedAt: a.lastUsedAt,
      policy: a.policy,
    }));

  const { ordered: routed, deferred } = applyRouting({
    candidates: healthyRoutable,
    strategy,
    now,
  });

  // Sticky session: if the profile we're continuing on is still healthy, pin it
  // to the front so a mid-session strategy (round-robin/weighted) can't drag the
  // conversation onto a different account and lose context.
  const ordered =
    opts.stickTo && routed.some((r) => r.name === opts.stickTo)
      ? [
          ...routed.filter((r) => r.name === opts.stickTo),
          ...routed.filter((r) => r.name !== opts.stickTo),
        ]
      : routed;

  const cooled = annotated
    .filter((a) => !a.healthy)
    .sort((x, y) => {
      const rx = cooldownRemainingMs(state.profiles[x.name], now) ?? Infinity;
      const ry = cooldownRemainingMs(state.profiles[y.name], now) ?? Infinity;
      return rx - ry;
    });

  const candidates: Candidate[] = [
    ...ordered.map((r) => toCandidate(r.name)),
    ...cooled.map((a) => toCandidate(a.name)),
  ];

  return { candidates, deferred, strategy };
}
