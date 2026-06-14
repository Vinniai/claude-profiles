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
import { loadProfiles } from './profiles.js';
import {
  getProfileState,
  recordUsage,
  setProfileCooldown,
  markNeedsAuth,
  markUsed,
} from './state.js';
import { classifyOutcome, type ClaudeOutcome, type FailureKind } from './claude-errors.js';
import {
  RATE_LIMIT_COOLDOWN_MS,
  SERVER_ERROR_COOLDOWN_MS,
} from './router.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';
import type { UsageBudget } from '../types/index.js';

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

/** The structured outcome of one worker run. */
export interface WorkerResult {
  profile: string;
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
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

// ──────────────────────────────────────────────────────────────────────────
// Spawn
// ──────────────────────────────────────────────────────────────────────────

export function claudeBin(): string {
  return process.env.CLAUDE_PROFILES_CLAUDE_BIN || 'claude';
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

/** The `claude` argv for a task (never `--bare` — that would skip OAuth). */
export function workerArgs(task: WorkerTask): string[] {
  const args = ['-p', task.prompt, '--output-format', 'json'];
  if (task.model) args.push('--model', task.model);
  if (task.resume) args.push('--resume', task.resume);
  if (task.extraArgs?.length) args.push(...task.extraArgs);
  return args;
}

/** Grace period after a timeout's SIGTERM before we force the child down with SIGKILL. */
const KILL_GRACE_MS = 2000;

/** Real capturing spawn: subscription OAuth, stdout/stderr captured, optional timeout. */
export const captureWorker: WorkerSpawn = (configDir, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, {
      env: workerEnv(configDir),
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
            `Could not find the "${claudeBin()}" CLI on your PATH`,
            ErrorCode.CLAUDE_NOT_FOUND,
            'Install Claude Code, or set CLAUDE_PROFILES_CLAUDE_BIN to its path.',
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
  configDir: string,
  opts: { spawnImpl?: WorkerSpawn; now?: Date } = {},
): Promise<WorkerResult> {
  const spawnImpl = opts.spawnImpl ?? captureWorker;
  const now = opts.now ?? new Date();

  let raw: { exitCode: number | null; stdout: string; stderr: string };
  try {
    raw = await spawnImpl(configDir, workerArgs(task), task.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      profile: task.profile,
      ok: false,
      kind: 'other',
      text: '',
      outcome: { ok: false, kind: 'other', resetAt: null, reason: 'spawn failed', raw: message },
      error: message,
    };
  }

  const outcome = classifyOutcome(raw, now);
  const envelope = parseEnvelope(raw.stdout);

  return {
    profile: task.profile,
    ok: outcome.ok,
    kind: outcome.kind,
    // `text` is the assistant's final output and only meaningful on success; on a
    // failure the envelope's `result` is an error message, surfaced via `reason`.
    text: outcome.ok ? (envelope?.result ?? raw.stdout.trim()) : '',
    sessionId: envelope?.session_id,
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

/** Run a single task end-to-end: resolve dir → run → apply effects. */
export async function dispatch(
  task: WorkerTask,
  opts: FleetOptions = {},
): Promise<WorkerResult> {
  const now = opts.now ?? new Date();
  const configDir = await resolveConfigDir(task.profile);
  const result = await runWorker(task, configDir, { spawnImpl: opts.spawnImpl, now });
  if (opts.recordEffects !== false) await applyWorkerEffects(result, now);
  return result;
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
  const dirs = await Promise.allSettled(tasks.map((t) => resolveConfigDir(t.profile)));

  const results: WorkerResult[] = new Array(tasks.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < tasks.length) {
      const i = cursor++;
      const dir = dirs[i];
      if (dir.status === 'rejected') {
        // Mirror runWorker's spawn-failure shape: a self-contained failed result,
        // input-order preserved, so a bad profile never throws out of the batch.
        const message = dir.reason instanceof Error ? dir.reason.message : String(dir.reason);
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
      results[i] = await runWorker(tasks[i], dir.value, { spawnImpl: opts.spawnImpl, now });
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
