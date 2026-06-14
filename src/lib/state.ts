import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { getClaudeProfilesDir } from './paths.js';
import { mergeBudget } from './usage.js';
import type {
  BurnRate,
  CapOverride,
  ProfileRuntimeState,
  RoutingEventKind,
  RuntimeStateFile,
  UsageBudget,
} from '../types/index.js';

/**
 * Runtime health (cooldowns / needs-auth) for profiles. Persisted separately
 * from `profiles.json` so concurrent `run` processes and config edits never
 * clobber each other, and writes are atomic (tmp file + rename).
 */
const STATE_FILE = 'state.json';

function getStatePath(): string {
  return path.join(getClaudeProfilesDir(), STATE_FILE);
}

export async function loadState(): Promise<RuntimeStateFile> {
  const statePath = getStatePath();
  if (await fs.pathExists(statePath)) {
    try {
      const data = (await fs.readJson(statePath)) as RuntimeStateFile;
      if (data && typeof data === 'object' && data.profiles) return data;
    } catch {
      // Corrupt state is non-critical — treat as empty and let it be rewritten.
    }
  }
  return { profiles: {} };
}

async function saveState(state: RuntimeStateFile): Promise<void> {
  const statePath = getStatePath();
  await fs.ensureDir(path.dirname(statePath));
  // Unique per writer (pid + random token) so two concurrent in-process writers
  // can't collide on the same temp file and rename a half-written one over state.
  const tmpPath = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeJson(tmpPath, state, { spaces: 2 });
  await fs.rename(tmpPath, statePath);
}

// ─── Cross-process + in-process write lock ───────────────────────────────────
// A read-modify-write (load → mutate → save) must be atomic against *other*
// writers, or two of them read the same snapshot and the second save clobbers
// the first's change. An exclusive lock file serializes writers both within this
// process (the second `wx` open EEXISTs and retries) and across the fleet's
// separate `claude -p` worker processes.

const LOCK_STALE_MS = 10_000; // steal a lock whose holder seemingly died
const LOCK_RETRY_MS = 12; // poll interval while waiting to acquire
const LOCK_MAX_WAIT_MS = 5_000; // give up waiting rather than hang forever

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `fn` while holding an exclusive lock on the state file. */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${getStatePath()}.lock`;
  await fs.ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  for (;;) {
    try {
      const fd = await fs.open(lockPath, 'wx'); // exclusive create
      await fs.close(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Held by someone else. Steal it if it looks abandoned, else wait.
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.remove(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // Lock vanished between EEXIST and stat — race to re-acquire.
        continue;
      }
      // Bound the wait: proceed unlocked rather than deadlock the CLI forever.
      if (Date.now() >= deadline) break;
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.remove(lockPath).catch(() => {});
  }
}

export async function getProfileState(
  name: string
): Promise<ProfileRuntimeState> {
  const state = await loadState();
  return state.profiles[name] ?? {};
}

/**
 * Read-modify-write a single profile's runtime state. Re-reads immediately
 * before writing to minimize lost updates between concurrent processes.
 */
async function updateProfileState(
  name: string,
  patch: Partial<ProfileRuntimeState> | null
): Promise<void> {
  await withStateLock(async () => {
    const state = await loadState();
    if (patch === null) {
      delete state.profiles[name];
    } else {
      state.profiles[name] = { ...state.profiles[name], ...patch };
    }
    await saveState(state);
  });
}

export async function setProfileCooldown(
  name: string,
  cooldownUntil: Date,
  error: string,
  now: Date = new Date(),
  kind: RoutingEventKind = 'limit'
): Promise<void> {
  await updateProfileState(name, {
    cooldownUntil: cooldownUntil.toISOString(),
    lastError: error,
    lastErrorAt: now.toISOString(),
    lastEventKind: kind,
    needsAuth: false,
  });
}

export async function markNeedsAuth(
  name: string,
  error: string,
  now: Date = new Date()
): Promise<void> {
  await updateProfileState(name, {
    needsAuth: true,
    lastError: error,
    lastErrorAt: now.toISOString(),
    lastEventKind: 'auth',
  });
}

export async function clearProfileState(name: string): Promise<void> {
  await updateProfileState(name, null);
}

/**
 * Merge a freshly-observed usage budget into a profile's stored budget. Used by
 * the router after each run to keep session/weekly figures current for strategic
 * routing. Does nothing if the observation is empty.
 */
export async function recordUsage(
  name: string,
  observed: UsageBudget
): Promise<void> {
  if (!observed.session && !observed.weekly) return;
  // Merge inside the lock so a concurrent writer's usage isn't read-then-clobbered.
  await withStateLock(async () => {
    const state = await loadState();
    const current = state.profiles[name] ?? {};
    state.profiles[name] = { ...current, usage: mergeBudget(current.usage, observed) };
    await saveState(state);
  });
}

/** Overwrite a profile's stored usage budget outright (manual `usage set`). */
export async function setUsage(
  name: string,
  usage: UsageBudget
): Promise<void> {
  await updateProfileState(name, { usage });
}

/** Drop a profile's stored usage budget. */
export async function clearUsage(name: string): Promise<void> {
  await withStateLock(async () => {
    const state = await loadState();
    const current = state.profiles[name];
    if (!current?.usage) return;
    const next = { ...current };
    delete next.usage;
    // Replace wholesale so the `usage` key is actually removed.
    state.profiles[name] = next;
    await saveState(state);
  });
}

/** Persist a freshly-computed burn-rate estimate for a profile. */
export async function recordBurn(name: string, burn: BurnRate): Promise<void> {
  await updateProfileState(name, { burn });
}

/**
 * Raise (or set) a profile's session cap — the "push past the danger zone"
 * control. The override is keyed to the account and auto-expires at `until`
 * (typically the current 5h window's reset) so it never outlives its window.
 */
export async function setCapOverride(
  name: string,
  override: CapOverride,
): Promise<void> {
  await updateProfileState(name, { capOverride: override });
}

/** Remove a profile's cap override, restoring the configured cap. */
export async function clearCapOverride(name: string): Promise<void> {
  await withStateLock(async () => {
    const state = await loadState();
    const current = state.profiles[name];
    if (!current?.capOverride) return;
    const next = { ...current };
    delete next.capOverride;
    state.profiles[name] = next;
    await saveState(state);
  });
}

/** Stamp a profile as just-used, so `round-robin` can spread load over time. */
export async function markUsed(
  name: string,
  now: Date = new Date()
): Promise<void> {
  await updateProfileState(name, { lastUsedAt: now.toISOString() });
}

export async function clearAllState(): Promise<void> {
  await withStateLock(async () => {
    await saveState({ profiles: {} });
  });
}

/**
 * A profile is healthy when it is not flagged `needsAuth` and any cooldown has
 * already elapsed.
 */
export function isHealthy(
  s: ProfileRuntimeState | undefined,
  now: Date = new Date()
): boolean {
  if (!s) return true;
  if (s.needsAuth) return false;
  if (s.cooldownUntil) {
    const until = new Date(s.cooldownUntil);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) {
      return false;
    }
  }
  return true;
}

/** Soonest moment a cooled-down profile becomes available again (or null). */
export function cooldownRemainingMs(
  s: ProfileRuntimeState | undefined,
  now: Date = new Date()
): number | null {
  if (!s?.cooldownUntil) return null;
  const until = new Date(s.cooldownUntil);
  if (Number.isNaN(until.getTime())) return null;
  return Math.max(0, until.getTime() - now.getTime());
}
