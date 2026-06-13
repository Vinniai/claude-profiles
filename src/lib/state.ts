import fs from 'fs-extra';
import path from 'path';
import { getClaudeProfilesDir } from './paths.js';
import { mergeBudget } from './usage.js';
import type {
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
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeJson(tmpPath, state, { spaces: 2 });
  await fs.rename(tmpPath, statePath);
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
  const state = await loadState();
  if (patch === null) {
    delete state.profiles[name];
  } else {
    state.profiles[name] = { ...state.profiles[name], ...patch };
  }
  await saveState(state);
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
  const current = await getProfileState(name);
  const usage = mergeBudget(current.usage, observed);
  await updateProfileState(name, { usage });
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
  const current = await getProfileState(name);
  if (!current.usage) return;
  const next = { ...current };
  delete next.usage;
  // Replace wholesale so the `usage` key is actually removed.
  const state = await loadState();
  state.profiles[name] = next;
  await saveState(state);
}

/** Stamp a profile as just-used, so `round-robin` can spread load over time. */
export async function markUsed(
  name: string,
  now: Date = new Date()
): Promise<void> {
  await updateProfileState(name, { lastUsedAt: now.toISOString() });
}

export async function clearAllState(): Promise<void> {
  await saveState({ profiles: {} });
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
