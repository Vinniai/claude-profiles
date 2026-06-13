/**
 * Install/remove the `claude-profiles statusline` command in the user's SHARED
 * `~/.claude/settings.json`. Every profile symlinks `settings.json` back to this
 * file, so one install lights up the account-aware status bar for all accounts —
 * each session renders the account it runs under (from CLAUDE_CONFIG_DIR) plus
 * its live 5-hour rate-limit bar, using the free stdin JSON Claude Code provides.
 */

import fs from 'fs-extra';
import path from 'path';
import { getSettingsPath, resolveHookBin } from './hooks-install.js';

/** Marker that identifies the statusLine entry as ours, regardless of bin path. */
const STATUSLINE_MARKER = 'statusline';

interface StatusLineEntry {
  type: 'command';
  command: string;
  padding?: number;
}
interface SettingsShape {
  statusLine?: StatusLineEntry;
  [k: string]: unknown;
}

function statusLineCommand(bin: string): string {
  return `${bin} ${STATUSLINE_MARKER}`;
}

function isOurStatusLine(entry: StatusLineEntry | undefined): boolean {
  return (
    !!entry &&
    typeof entry.command === 'string' &&
    entry.command.includes(STATUSLINE_MARKER)
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
  settings: SettingsShape,
): Promise<void> {
  await fs.ensureDir(path.dirname(settingsPath));
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeJson(tmp, settings, { spaces: 2 });
  await fs.rename(tmp, settingsPath);
}

/** True when our statusLine command is the one configured. */
export async function statusLineInstalled(
  settingsPath: string = getSettingsPath(),
): Promise<boolean> {
  const settings = await readSettings(settingsPath);
  return isOurStatusLine(settings.statusLine);
}

/**
 * Install (or refresh) our statusLine entry. Idempotent. Refuses to clobber a
 * DIFFERENT (user-defined) statusLine unless `force` is set — returns the
 * existing command so the caller can warn.
 */
export async function installStatusLine(
  settingsPath: string = getSettingsPath(),
  bin: string = resolveHookBin(),
  force = false,
): Promise<{ installed: boolean; conflict?: string }> {
  const settings = await readSettings(settingsPath);
  const existing = settings.statusLine;
  if (existing && !isOurStatusLine(existing) && !force) {
    return { installed: false, conflict: existing.command };
  }
  settings.statusLine = { type: 'command', command: statusLineCommand(bin), padding: 0 };
  await writeSettings(settingsPath, settings);
  return { installed: true };
}

/** Remove our statusLine entry; leaves a user-defined one untouched. */
export async function removeStatusLine(
  settingsPath: string = getSettingsPath(),
): Promise<boolean> {
  const settings = await readSettings(settingsPath);
  if (!isOurStatusLine(settings.statusLine)) return false;
  delete settings.statusLine;
  await writeSettings(settingsPath, settings);
  return true;
}
