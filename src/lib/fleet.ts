/**
 * Fleet — run headless `claude` workers across several profiles from one parent
 * process, so a single orchestrator session can delegate work to other accounts
 * and collect structured results.
 *
 * Each worker is a separate `claude -p --output-format json` child pinned to a
 * profile via `CLAUDE_CONFIG_DIR`. That is the one transport that is CONFIRMED to
 * run on a Max **subscription** (OAuth) rather than per-token API billing — but
 * only if no API key leaks into the child's environment. So every worker spawn
 * scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (either would silently take
 * precedence over the subscription login) and never passes `--bare` (bare mode
 * skips OAuth and demands an API key). Subscription `-p` usage draws from the
 * per-account Agent SDK credit, not the interactive 5h/7d pool.
 *
 * The spawn + parse + classify path is pure-ish and injectable for tests. State
 * mutations (cooldowns, usage, last-used) are deliberately kept OUT of the
 * concurrent path — `runFleet` applies them sequentially after the batch settles
 * so parallel workers never race on the read-modify-write of state.json.
 */

import { spawn } from 'child_process';
import { getProfileProvider, loadProfiles } from './profiles.js';
import {
  getProfileState,
  loadState,
  recordUsage,
  setProfileCooldown,
  markNeedsAuth,
  markUsed,
  isHealthy,
} from './state.js';
import {
  classifyOutcome,
  shouldFailover,
  type ClaudeOutcome,
  type FailureKind,
} from './claude-errors.js';
import {
  RATE_LIMIT_COOLDOWN_MS,
  SERVER_ERROR_COOLDOWN_MS,
} from './router.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';
import type { UsageBudget } from '../types/index.js';
import type {
  Profile,
  ProfileProvider,
  ProviderModelMap,
  ProviderSkillsMap,
  TaskRouteConfig,
} from '../types/index.js';
import { parseCodexJsonl } from './codex-output.js';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** A unit of work to dispatch to one profile. */
export interface WorkerTask {
  /** Profile name to run under (must exist in the config). */
  profile: string;
  /** The prompt to send to `claude -p`. */
  prompt: string;
  /** Optional model override (e.g. `claude-haiku-4-5-20251001`). */
  model?: string;
  /** Resume a prior session id so the worker keeps its context across turns. */
  resume?: string;
  /** Hard timeout in ms; the child is killed and the task fails if exceeded. */
  timeoutMs?: number;
  /**
   * Extra raw `claude` args appended after the standard ones (e.g. the
   * orchestrator's `--mcp-config` / `--allowedTools`). Kept last so a trailing
   * variadic flag like `--allowedTools a b c` stays intact.
   */
  extraArgs?: string[];
}

/** MCP-facing task that may select a worker directly or through a route. */
export interface RoutedWorkerTask extends Omit<WorkerTask, 'profile'> {
  profile?: string;
  /** Existing ordered fallback chain from profiles.json. */
  chain?: string;
  /** Task class resolved through `taskRouting` or profile.taskTypes. */
  taskType?: string;
  /** Extra ordered candidates appended after the primary selector. */
  fallbackProfiles?: string[];
  /** Defaults true for chain/taskType selectors and false for one profile. */
  fallback?: boolean;
  /** Provider-specific model override. Wins over the legacy `model` field. */
  models?: ProviderModelMap;
  /** Skills every provider should use for this task. */
  skills?: string[];
  /** Skills requested only when a specific provider handles the task. */
  providerSkills?: ProviderSkillsMap;
  /**
   * Context from the calling session to carry into a fresh fallback session.
   * Use this for requirements, decisions, artifact paths, and work completed.
   */
  handoffContext?: string;
}

export interface WorkerAttempt {
  profile: string;
  provider: ProfileProvider;
  model?: string;
  skills: string[];
  ok: boolean;
  kind: FailureKind;
  reason: string;
  sessionId?: string;
}

/** The structured outcome of one worker run. */
export interface WorkerResult {
  profile: string;
  provider?: ProfileProvider;
  ok: boolean;
  kind: FailureKind;
  /** The assistant's final text (the `result` field of the JSON envelope). */
  text: string;
  /** Session id from the envelope — pass back as `resume` to continue. */
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  /** The classified outcome (reason, parsed reset time, raw text). */
  outcome: ClaudeOutcome;
  /** Populated for spawn/timeout failures that never produced an envelope. */
  error?: string;
  /** Profiles tried by a routed/fallback dispatch, in order. */
  attemptedProfiles?: string[];
  /** Provider-specific model selected for the successful/final attempt. */
  modelUsed?: string;
  /** Skills requested for the successful/final attempt. */
  skillsUsed?: string[];
  /** Full failover trace returned to the calling Claude/Codex session. */
  attempts?: WorkerAttempt[];
  /** Original session that could not be resumed across an account/provider boundary. */
  handoffFromSessionId?: string;
}

/** The shape of `claude -p --output-format json`'s single result object. */
interface ResultEnvelope {
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

/** Spawn factory injected for tests; defaults to the real subscription spawn. */
export type WorkerSpawn = (
  configDir: string,
  args: string[],
  timeoutMs?: number,
  provider?: ProfileProvider,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

// ──────────────────────────────────────────────────────────────────────────
// Spawn
// ──────────────────────────────────────────────────────────────────────────

export function claudeBin(): string {
  return process.env.CLAUDE_PROFILES_CLAUDE_BIN || 'claude';
}

export function codexBin(): string {
  return process.env.CLAUDE_PROFILES_CODEX_BIN || 'codex';
}

/**
 * Build the env for a worker: pin the profile's config dir and STRIP any API-key
 * variables so the child authenticates with the profile's subscription OAuth.
 */
export function workerEnv(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: configDir };
  // Either of these would override the subscription login and bill the API.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function codexWorkerEnv(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CODEX_HOME: configDir };
  // Fleet account profiles are ChatGPT/Codex-login identities. Avoid silently
  // switching a worker to API billing because the parent shell exported a key.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

/** The `claude` argv for a task (never `--bare` — that would skip OAuth). */
export function workerArgs(task: WorkerTask): string[] {
  const args = ['-p', task.prompt, '--output-format', 'json'];
  if (task.model) args.push('--model', task.model);
  if (task.resume) args.push('--resume', task.resume);
  if (task.extraArgs?.length) args.push(...task.extraArgs);
  return args;
}

export function codexWorkerArgs(task: WorkerTask, profile: Profile): string[] {
  const prefix = [
    ...(profile.configProfile ? ['--profile', profile.configProfile] : []),
    // A native config profile is layered over config.toml. Keep credentials
    // file-backed even if that layer declares a different credential store.
    '--config',
    'cli_auth_credentials_store="file"',
  ];
  if (task.resume) {
    const args = [...prefix, 'exec', 'resume', '--json'];
    if (task.model) args.push('--model', task.model);
    args.push(task.resume, task.prompt);
    return args;
  }
  const args = [...prefix, 'exec', '--json'];
  if (task.model) args.push('--model', task.model);
  args.push(task.prompt);
  return args;
}

/** Grace period after a timeout's SIGTERM before we force the child down with SIGKILL. */
const KILL_GRACE_MS = 2000;

/** Real capturing spawn: subscription OAuth, stdout/stderr captured, optional timeout. */
export const captureWorker: WorkerSpawn = (
  configDir,
  args,
  timeoutMs,
  provider = 'claude',
) =>
  new Promise((resolve, reject) => {
    const bin = provider === 'codex' ? codexBin() : claudeBin();
    const child = spawn(bin, args, {
      env:
        provider === 'codex'
          ? codexWorkerEnv(configDir)
          : workerEnv(configDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        stderr += `\n[fleet] worker timed out after ${timeoutMs}ms`;
        // Escalate to SIGKILL if the child ignores or is slow on SIGTERM, so a
        // wedged worker can't hang this promise (and its awaiter) indefinitely.
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
    }
    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      // Must clear the escalation timer on exit, or it could SIGKILL a recycled PID.
      if (killTimer) clearTimeout(killTimer);
    };
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimers();
      if (err.code === 'ENOENT') {
        reject(
          new ClaudeProfilesError(
            `Could not find the "${bin}" CLI on your PATH`,
            provider === 'codex'
              ? ErrorCode.CODEX_NOT_FOUND
              : ErrorCode.CLAUDE_NOT_FOUND,
            provider === 'codex'
              ? 'Install Codex CLI, or set CLAUDE_PROFILES_CODEX_BIN to its path.'
              : 'Install Claude Code, or set CLAUDE_PROFILES_CLAUDE_BIN to its path.',
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      clearTimers();
      resolve({ exitCode: code, stdout, stderr });
    });
  });

// ──────────────────────────────────────────────────────────────────────────
// Parse + run
// ──────────────────────────────────────────────────────────────────────────

/** Pull the result envelope out of `--output-format json` stdout, best-effort. */
export function parseEnvelope(stdout: string): ResultEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const obj = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    if (!obj || typeof obj !== 'object') return null;
    return obj as ResultEnvelope;
  } catch {
    return null;
  }
}

/**
 * Run one task and return a structured result. PURE w.r.t. claude-profiles state
 * — it never writes state.json. Apply side effects with {@link applyWorkerEffects}
 * (done for you by {@link runFleet}). The `now` and `spawnImpl` are injectable.
 */
export async function runWorker(
  task: WorkerTask,
  profileOrConfigDir: Profile | string,
  opts: { spawnImpl?: WorkerSpawn; now?: Date } = {},
): Promise<WorkerResult> {
  const spawnImpl = opts.spawnImpl ?? captureWorker;
  const now = opts.now ?? new Date();
  const profile: Profile =
    typeof profileOrConfigDir === 'string'
      ? { alias: `claude-${task.profile}`, configDir: profileOrConfigDir }
      : profileOrConfigDir;
  const provider = getProfileProvider(profile);
  const args =
    provider === 'codex' ? codexWorkerArgs(task, profile) : workerArgs(task);

  let raw: { exitCode: number | null; stdout: string; stderr: string };
  try {
    raw = await spawnImpl(profile.configDir, args, task.timeoutMs, provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      profile: task.profile,
      provider,
      ok: false,
      kind: 'other',
      text: '',
      outcome: { ok: false, kind: 'other', resetAt: null, reason: 'spawn failed', raw: message },
      error: message,
    };
  }

  const codex = provider === 'codex' ? parseCodexJsonl(raw.stdout) : undefined;
  const classifiedRaw =
    codex?.failed && raw.exitCode === 0
      ? {
          ...raw,
          exitCode: 1,
          stderr: [raw.stderr, codex.errorText].filter(Boolean).join('\n'),
        }
      : raw;
  const outcome = classifyOutcome(classifiedRaw, now);
  const envelope = provider === 'claude' ? parseEnvelope(raw.stdout) : null;

  return {
    profile: task.profile,
    provider,
    ok: outcome.ok,
    kind: outcome.kind,
    // `text` is the assistant's final output and only meaningful on success; on a
    // failure the envelope's `result` is an error message, surfaced via `reason`.
    text: outcome.ok
      ? provider === 'codex'
        ? codex?.text ?? ''
        : envelope?.result ?? raw.stdout.trim()
      : '',
    sessionId: provider === 'codex' ? codex?.threadId : envelope?.session_id,
    costUsd: envelope?.total_cost_usd,
    durationMs: envelope?.duration_ms,
    numTurns: envelope?.num_turns,
    outcome,
  };
}

/**
 * Persist what a worker run tells us about its account's health — a cooldown on a
 * rate-limit (using the parsed reset time when present), a needs-auth flag on an
 * auth failure, or a last-used stamp on success. Called sequentially so the fleet
 * never races on state.json.
 */
export async function applyWorkerEffects(
  result: WorkerResult,
  now: Date = new Date(),
): Promise<void> {
  if (result.ok) {
    await markUsed(result.profile, now);
    return;
  }
  switch (result.kind) {
    case 'rate_limit': {
      // Only trust resetAt if it's in the future — a stale/past reset time would
      // make an immediately-expired cooldown, treating the throttled profile as
      // healthy again right away (mirrors the guard in router.ts).
      const reset = result.outcome.resetAt;
      const until =
        reset && reset.getTime() > now.getTime()
          ? reset
          : new Date(now.getTime() + RATE_LIMIT_COOLDOWN_MS);
      await setProfileCooldown(result.profile, until, result.outcome.reason, now);
      break;
    }
    case 'server_error': {
      const until = new Date(now.getTime() + SERVER_ERROR_COOLDOWN_MS);
      await setProfileCooldown(result.profile, until, result.outcome.reason, now);
      break;
    }
    case 'auth':
      await markNeedsAuth(result.profile, result.outcome.reason);
      break;
    default:
      // `other` failures aren't an account-health signal — leave state untouched.
      break;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Fleet dispatch
// ──────────────────────────────────────────────────────────────────────────

export interface FleetOptions {
  /** Max workers running at once (default 4). Excess tasks queue. */
  concurrency?: number;
  /** Apply health side effects after the batch (default true). */
  recordEffects?: boolean;
  /** Injected spawn for tests. */
  spawnImpl?: WorkerSpawn;
  now?: Date;
}

/** Resolve a profile's config dir, throwing a typed error if it's unknown. */
export async function resolveConfigDir(profile: string): Promise<string> {
  const config = await loadProfiles();
  const p = config.profiles[profile];
  if (!p) {
    throw new ClaudeProfilesError(
      `No profile named "${profile}"`,
      ErrorCode.PROFILE_NOT_FOUND,
      `Known profiles: ${Object.keys(config.profiles).join(', ') || '(none)'}`,
    );
  }
  return p.configDir;
}

export async function resolveProfile(profile: string): Promise<Profile> {
  const config = await loadProfiles();
  const p = config.profiles[profile];
  if (!p) {
    throw new ClaudeProfilesError(
      `No profile named "${profile}"`,
      ErrorCode.PROFILE_NOT_FOUND,
      `Known profiles: ${Object.keys(config.profiles).join(', ') || '(none)'}`,
    );
  }
  return p;
}

/** Run a single task end-to-end: resolve dir → run → apply effects. */
export async function dispatch(
  task: WorkerTask,
  opts: FleetOptions = {},
): Promise<WorkerResult> {
  const now = opts.now ?? new Date();
  const profile = await resolveProfile(task.profile);
  const result = await runWorker(task, profile, { spawnImpl: opts.spawnImpl, now });
  if (opts.recordEffects !== false) await applyWorkerEffects(result, now);
  return result;
}

export async function resolveRoutedProfiles(
  task: RoutedWorkerTask,
  now: Date = new Date(),
): Promise<{
  names: string[];
  fallback: boolean;
  routeConfig?: TaskRouteConfig;
}> {
  const selectors = [task.profile, task.chain, task.taskType].filter(Boolean);
  if (selectors.length !== 1) {
    throw new ClaudeProfilesError(
      'A fleet task requires exactly one of profile, chain, or taskType',
      ErrorCode.INVALID_CONFIG,
      'Set one selector and optionally add fallbackProfiles.',
    );
  }

  const config = await loadProfiles();
  let names: string[];
  let routeConfig: TaskRouteConfig | undefined;
  if (task.profile) {
    names = [task.profile];
  } else if (task.chain) {
    names = [...(config.chains?.[task.chain] ?? [])];
    if (names.length === 0) {
      throw new ClaudeProfilesError(
        `Chain "${task.chain}" not found or empty`,
        ErrorCode.NO_CHAIN,
      );
    }
  } else {
    const configured = config.taskRouting?.[task.taskType!];
    routeConfig = Array.isArray(configured) ? undefined : configured;
    const configuredProfiles = Array.isArray(configured)
      ? configured
      : configured?.profiles;
    names = configuredProfiles?.length
      ? [...configuredProfiles]
      : Object.entries(config.profiles)
          .filter(([, p]) => p.taskTypes?.includes(task.taskType!))
          .sort(([, a], [, b]) => (a.priority ?? 1000) - (b.priority ?? 1000))
          .map(([name]) => name);
    if (names.length === 0) {
      throw new ClaudeProfilesError(
        `No profiles are assigned to task type "${task.taskType}"`,
        ErrorCode.PROFILE_NOT_FOUND,
        'Set profile taskTypes or add taskRouting in profiles.json.',
      );
    }
  }

  names.push(...(task.fallbackProfiles ?? []));
  names = [...new Set(names)];
  const unknown = names.filter((name) => !config.profiles[name]);
  if (unknown.length) {
    throw new ClaudeProfilesError(
      `Unknown fleet profile${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
      ErrorCode.PROFILE_NOT_FOUND,
    );
  }

  // A resume id belongs to the configured primary account/provider. Preserve
  // that owner as the first attempt; health-based reordering could otherwise
  // send the id to a different account. Fresh tasks can skip unhealthy entries.
  if (!task.resume) {
    const state = await loadState();
    names.sort((a, b) => {
      const ah = isHealthy(state.profiles[a], now);
      const bh = isHealthy(state.profiles[b], now);
      return ah === bh ? 0 : ah ? -1 : 1;
    });
  }

  return {
    names,
    fallback:
      task.fallback ??
      Boolean(task.chain || task.taskType || task.fallbackProfiles?.length),
    routeConfig,
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function resolveAttemptModel(
  task: RoutedWorkerTask,
  provider: ProfileProvider,
  route?: TaskRouteConfig,
): string | undefined {
  return task.models?.[provider] ?? route?.models?.[provider] ?? task.model;
}

export function resolveAttemptSkills(
  task: RoutedWorkerTask,
  provider: ProfileProvider,
  route?: TaskRouteConfig,
): string[] {
  return uniqueStrings([
    ...(route?.skills ?? []),
    ...(route?.providerSkills?.[provider] ?? []),
    ...(task.skills ?? []),
    ...(task.providerSkills?.[provider] ?? []),
  ]);
}

export function buildRoutedPrompt(opts: {
  prompt: string;
  skills: string[];
  handoffContext?: string;
  priorAttempts?: WorkerAttempt[];
  sourceSessionId?: string;
}): string {
  const sections: string[] = [opts.prompt];
  if (opts.skills.length > 0) {
    sections.push(
      [
        'Required skills:',
        ...opts.skills.map((skill) => `- Use the installed "${skill}" skill.`),
        'If a required skill is unavailable, report that explicitly instead of silently substituting another workflow.',
      ].join('\n'),
    );
  }
  if (opts.handoffContext?.trim()) {
    sections.push(`Calling-session handoff context:\n${opts.handoffContext.trim()}`);
  }
  if (opts.priorAttempts?.length) {
    sections.push(
      [
        'Failover handoff:',
        ...opts.priorAttempts.map(
          (attempt) =>
            `- ${attempt.profile} (${attempt.provider}${attempt.model ? `, ${attempt.model}` : ''}) failed: ${attempt.reason}`,
        ),
        opts.sourceSessionId
          ? `The original session id was ${opts.sourceSessionId}. It belongs to another account/provider and cannot be resumed here. Continue in this fresh session and return the completed result to the calling orchestrator.`
          : 'Continue in this fresh session and return the completed result to the calling orchestrator.',
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

/**
 * Resolve and dispatch a routed task. Only account/transient failures advance
 * to the next candidate; generic task or tool failures are returned immediately.
 */
export async function dispatchRouted(
  task: RoutedWorkerTask,
  opts: FleetOptions = {},
): Promise<WorkerResult> {
  const now = opts.now ?? new Date();
  const route = await resolveRoutedProfiles(task, now);
  const attempted: string[] = [];
  const attempts: WorkerAttempt[] = [];
  let last: WorkerResult | undefined;

  for (const [index, name] of route.names.entries()) {
    attempted.push(name);
    const profile = await resolveProfile(name);
    const provider = getProfileProvider(profile);
    const model = resolveAttemptModel(task, provider, route.routeConfig);
    const skills = resolveAttemptSkills(task, provider, route.routeConfig);
    const prompt = buildRoutedPrompt({
      prompt: task.prompt,
      skills,
      handoffContext: task.handoffContext,
      priorAttempts: attempts,
      sourceSessionId: task.resume,
    });
    const result = await dispatch(
      {
        profile: name,
        prompt,
        model,
        // Session ids are provider/account-local. Never forward one to a
        // fallback account after the primary profile fails.
        resume: index === 0 ? task.resume : undefined,
        timeoutMs: task.timeoutMs,
        extraArgs: task.extraArgs,
      },
      opts,
    );
    result.attemptedProfiles = [...attempted];
    result.modelUsed = model;
    result.skillsUsed = skills;
    const attempt: WorkerAttempt = {
      profile: name,
      provider,
      model,
      skills,
      ok: result.ok,
      kind: result.kind,
      reason: result.outcome.reason,
      sessionId: result.sessionId,
    };
    attempts.push(attempt);
    result.attempts = [...attempts];
    if (index > 0 && task.resume) {
      result.handoffFromSessionId = task.resume;
    }
    if (result.ok) return result;
    last = result;
    if (!route.fallback || !shouldFailover(result.kind)) return result;
  }

  return (
    last ?? {
      profile: task.profile ?? task.chain ?? task.taskType ?? 'unknown',
      ok: false,
      kind: 'other',
      text: '',
      attemptedProfiles: attempted,
      outcome: {
        ok: false,
        kind: 'other',
        resetAt: null,
        reason: 'no routed profiles available',
        raw: '',
      },
    }
  );
}

export async function runRoutedFleet(
  tasks: RoutedWorkerTask[],
  opts: FleetOptions = {},
): Promise<WorkerResult[]> {
  const limit = Math.max(1, opts.concurrency ?? 4);
  const results = new Array<WorkerResult>(tasks.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = await dispatchRouted(tasks[index], opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[index] = {
          profile:
            tasks[index].profile ??
            tasks[index].chain ??
            tasks[index].taskType ??
            'unknown',
          ok: false,
          kind: 'other',
          text: '',
          error: message,
          outcome: {
            ok: false,
            kind: 'other',
            resetAt: null,
            reason: 'route resolution failed',
            raw: message,
          },
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, pump));
  return results;
}

/**
 * Dispatch many tasks concurrently (bounded by `concurrency`) and return results
 * in input order. Spawns run in parallel; state side effects are applied
 * SEQUENTIALLY afterwards so concurrent workers never clobber state.json.
 */
export async function runFleet(
  tasks: WorkerTask[],
  opts: FleetOptions = {},
): Promise<WorkerResult[]> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, opts.concurrency ?? 4);

  // Resolve every config dir up front (also validates profile names). Settle per
  // task so one unknown profile fails only its own slot — not the whole batch.
  const profiles = await Promise.allSettled(tasks.map((t) => resolveProfile(t.profile)));

  const results: WorkerResult[] = new Array(tasks.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < tasks.length) {
      const i = cursor++;
      const profile = profiles[i];
      if (profile.status === 'rejected') {
        // Mirror runWorker's spawn-failure shape: a self-contained failed result,
        // input-order preserved, so a bad profile never throws out of the batch.
        const message =
          profile.reason instanceof Error
            ? profile.reason.message
            : String(profile.reason);
        results[i] = {
          profile: tasks[i].profile,
          ok: false,
          kind: 'other',
          text: '',
          outcome: { ok: false, kind: 'other', resetAt: null, reason: 'unknown profile', raw: message },
          error: message,
        };
        continue;
      }
      results[i] = await runWorker(tasks[i], profile.value, {
        spawnImpl: opts.spawnImpl,
        now,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, pump));

  if (opts.recordEffects !== false) {
    for (const r of results) await applyWorkerEffects(r, now);
  }
  return results;
}

/** A compact health view of every profile, for `fleet_status`. */
export async function fleetStatus(now: Date = new Date()): Promise<
  Array<{
    name: string;
    provider: ProfileProvider;
    plan?: string;
    healthy: boolean;
    needsAuth: boolean;
    cooldownUntil?: string | null;
    lastUsedAt?: string;
    usage?: UsageBudget;
  }>
> {
  const config = await loadProfiles();
  const rows = [];
  for (const [name, p] of Object.entries(config.profiles)) {
    const s = await getProfileState(name);
    const cooling = s.cooldownUntil != null && Date.parse(s.cooldownUntil) > now.getTime();
    rows.push({
      name,
      provider: getProfileProvider(p),
      plan: p.plan,
      healthy: !cooling && !s.needsAuth,
      needsAuth: Boolean(s.needsAuth),
      cooldownUntil: s.cooldownUntil ?? null,
      lastUsedAt: s.lastUsedAt,
      usage: s.usage,
    });
  }
  return rows;
}
