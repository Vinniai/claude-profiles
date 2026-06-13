import os from 'os';
import path from 'path';
import fs from 'fs';
import type { ConfigPaths } from '../types/index.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

export function detectPlatform(): 'darwin' | 'linux' {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux') {
    return platform;
  }
  throw new ClaudeProfilesError(
    `Unsupported platform: ${platform}`,
    ErrorCode.UNSUPPORTED_PLATFORM,
    'claude-profiles supports macOS and Linux only.'
  );
}

const STATE_DIR = '.claude-profiles';
const LEGACY_STATE_DIR = '.jean-claude';

/**
 * Location of claude-profiles' own state (profiles.json, state.json, sync repo).
 *
 * One-time migration: if the legacy `.jean-claude` dir exists and the new
 * `.claude-profiles` dir does not, rename it in place so existing installs keep
 * their profiles after the rebrand.
 */
export function getClaudeProfilesDir(): string {
  const claudeDir = detectClaudeConfigDir();
  const current = path.join(claudeDir, STATE_DIR);
  const legacy = path.join(claudeDir, LEGACY_STATE_DIR);

  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, current);
    } catch {
      // If migration fails (e.g. permissions), fall back to the legacy dir so
      // the user's existing profiles remain reachable.
      return legacy;
    }
  }

  return current;
}

/** @deprecated Use `getClaudeProfilesDir`. Kept so existing imports keep working. */
export function getJeanClaudeDir(): string {
  return getClaudeProfilesDir();
}

export function detectClaudeConfigDir(): string {
  const home = os.homedir();

  // Primary location (same on both macOS and Linux)
  const primaryPath = path.join(home, '.claude');
  if (fs.existsSync(primaryPath)) {
    return primaryPath;
  }

  // Alternate XDG location (primarily Linux)
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const alternatePath = path.join(xdgConfigHome, 'claude-code');
  if (fs.existsSync(alternatePath)) {
    return alternatePath;
  }

  // Default to primary (will be created if needed)
  return primaryPath;
}

export function getConfigPaths(): ConfigPaths {
  return {
    jeanClaudeDir: getJeanClaudeDir(),
    claudeConfigDir: detectClaudeConfigDir(),
    platform: detectPlatform(),
  };
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
