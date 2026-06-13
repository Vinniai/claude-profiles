import fs from 'fs-extra';
import path from 'path';
import { detectClaudeConfigDir } from './paths.js';

/**
 * Installs claude-profiles' continuity hooks into the user's SHARED
 * `~/.claude/settings.json`. Because every profile symlinks `settings.json` back
 * to this file, one install covers all accounts. The hook command is a hidden
 * `claude-profiles _hook <event>` that no-ops unless a session was launched
 * through a chain (it keys off the `CLAUDE_PROFILES_CHAIN` env var), so normal
 * `claude` usage is unaffected.
 */

export const HOOK_EVENTS = [
  'SessionStart',
  'Stop',
  'SessionEnd',
  'PreCompact',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Marker that identifies a hook group as ours, regardless of bin path. */
const HOOK_MARKER = '_hook';

interface HookEntry {
  type: 'command';
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface SettingsShape {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export function getSettingsPath(): string {
  return path.join(detectClaudeConfigDir(), 'settings.json');
}

/**
 * Best command string for invoking our hook. When running from the global
 * `claude-profiles` bin we emit the bare command (portable across machines and
 * safe to sync); otherwise (dev / `node dist/index.js`) we emit an absolute
 * `node <script>` invocation so hooks still resolve.
 */
export function resolveHookBin(): string {
  const entry = process.argv[1] ?? '';
  const base = path.basename(entry);
  if (base === 'claude-profiles' || base === 'jean-claude') {
    return 'claude-profiles';
  }
  return `"${process.execPath}" "${entry}"`;
}

function hookCommand(bin: string, event: HookEvent): string {
  return `${bin} ${HOOK_MARKER} ${event}`;
}

function isOurGroup(group: HookGroup): boolean {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some(
      (h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)
    )
  );
}

async function readSettings(settingsPath: string): Promise<SettingsShape> {
  if (!(await fs.pathExists(settingsPath))) return {};
  try {
    return (await fs.readJson(settingsPath)) as SettingsShape;
  } catch {
    return {};
  }
}

async function writeSettings(
  settingsPath: string,
  settings: SettingsShape
): Promise<void> {
  await fs.ensureDir(path.dirname(settingsPath));
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeJson(tmp, settings, { spaces: 2 });
  await fs.rename(tmp, settingsPath);
}

/** True when every continuity hook is present in the settings file. */
export async function hooksInstalled(
  settingsPath: string = getSettingsPath()
): Promise<boolean> {
  const settings = await readSettings(settingsPath);
  const hooks = settings.hooks ?? {};
  return HOOK_EVENTS.every((event) =>
    (hooks[event] ?? []).some(isOurGroup)
  );
}

/**
 * Install (or refresh) our hook groups. Idempotent: existing claude-profiles
 * groups are replaced, never duplicated, and unrelated hooks are preserved.
 */
export async function installHooks(
  settingsPath: string = getSettingsPath(),
  bin: string = resolveHookBin()
): Promise<void> {
  const settings = await readSettings(settingsPath);
  settings.hooks = settings.hooks ?? {};

  for (const event of HOOK_EVENTS) {
    const groups = (settings.hooks[event] ?? []).filter((g) => !isOurGroup(g));
    groups.push({ hooks: [{ type: 'command', command: hookCommand(bin, event) }] });
    settings.hooks[event] = groups;
  }

  await writeSettings(settingsPath, settings);
}

/** Remove our hook groups, leaving any user-defined hooks intact. */
export async function removeHooks(
  settingsPath: string = getSettingsPath()
): Promise<boolean> {
  const settings = await readSettings(settingsPath);
  if (!settings.hooks) return false;

  let changed = false;
  for (const event of HOOK_EVENTS) {
    const existing = settings.hooks[event];
    if (!existing) continue;
    const kept = existing.filter((g) => !isOurGroup(g));
    if (kept.length !== existing.length) changed = true;
    if (kept.length === 0) {
      delete settings.hooks[event];
    } else {
      settings.hooks[event] = kept;
    }
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (changed) await writeSettings(settingsPath, settings);
  return changed;
}

/** Install hooks only if they aren't already present (lazy, out-of-the-box). */
export async function ensureHooksInstalled(
  settingsPath: string = getSettingsPath()
): Promise<boolean> {
  if (await hooksInstalled(settingsPath)) return false;
  await installHooks(settingsPath);
  return true;
}
