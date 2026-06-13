import fs from 'fs-extra';
import path from 'path';
import { getClaudeProfilesDir } from './paths.js';
import type { ProfileRuntimeState, RuntimeStateFile } from '../types/index.js';

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
  now: Date = new Date()
): Promise<void> {
  await updateProfileState(name, {
    cooldownUntil: cooldownUntil.toISOString(),
    lastError: error,
    lastErrorAt: now.toISOString(),
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
  });
}

export async function clearProfileState(name: string): Promise<void> {
  await updateProfileState(name, null);
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
