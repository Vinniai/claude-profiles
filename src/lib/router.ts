import { spawn } from 'child_process';
import {
  ClaudeProfilesError,
  ErrorCode,
  type Profile,
  type ProfileConfig,
  type RuntimeStateFile,
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
}

/**
 * Resolve the ordered list of profile names to try, given a `--chain`,
 * `--profile`, or neither (default chain, else all profiles by priority).
 */
export function resolveProfileNames(
  config: ProfileConfig,
  opts: { chain?: string; profile?: string }
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
  // profiles ordered by ascending priority (undefined sorts last), then name.
  const defaultChain = config.chains?.default;
  if (defaultChain && defaultChain.length > 0) {
    return defaultChain.filter((n) => config.profiles[n]);
  }

  return Object.keys(config.profiles).sort((a, b) => {
    const pa = config.profiles[a].priority ?? Number.MAX_SAFE_INTEGER;
    const pb = config.profiles[b].priority ?? Number.MAX_SAFE_INTEGER;
    return pa === pb ? a.localeCompare(b) : pa - pb;
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
    await setProfileCooldown(name, until, outcome.reason, now);
    return;
  }
  if (outcome.kind === 'server_error') {
    await setProfileCooldown(
      name,
      new Date(now.getTime() + SERVER_ERROR_COOLDOWN_MS),
      outcome.reason,
      now
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
  onFallback?: (name: string, reason: string, next: string | null) => void;
  now?: () => Date;
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
      onFallback?.(c.name, outcome.reason, next);
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
  onRelaunch?: (from: string, to: string) => void;
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
    onRelaunch?.(current.name, next.name);
    current = next;
  }

  return { lastProfile: path[path.length - 1], exitCode, path };
}

/** Load config + state and produce the ordered candidate list in one step. */
export async function buildCandidates(
  config: ProfileConfig,
  opts: { chain?: string; profile?: string },
  now: Date = new Date()
): Promise<Candidate[]> {
  const names = resolveProfileNames(config, opts);
  const state = await loadState();
  return orderCandidates(names, config, state, now);
}
