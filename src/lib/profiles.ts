import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { getConfigPaths, getClaudeProfilesDir } from './paths.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';
import type { ProfileConfig, Profile } from '../types/index.js';

const PROFILES_FILE = 'profiles.json';

/**
 * Items that get symlinked from the main ~/.claude/ into profile directories.
 * Everything else in the profile dir is profile-specific.
 */
export const SHARED_ITEMS = [
  { name: 'settings.json', type: 'file' as const },
  { name: 'hooks', type: 'directory' as const },
  { name: 'agents', type: 'directory' as const },
  { name: 'skills', type: 'directory' as const },
  { name: 'plugins', type: 'directory' as const },
  { name: 'keybindings.json', type: 'file' as const },
];

function getProfilesPath(): string {
  return path.join(getClaudeProfilesDir(), PROFILES_FILE);
}

export async function loadProfiles(): Promise<ProfileConfig> {
  const profilesPath = getProfilesPath();
  if (await fs.pathExists(profilesPath)) {
    return await fs.readJson(profilesPath);
  }
  return { profiles: {} };
}

export async function saveProfiles(config: ProfileConfig): Promise<void> {
  const profilesPath = getProfilesPath();
  const tmpPath = `${profilesPath}.${process.pid}.tmp`;
  await fs.writeJson(tmpPath, config, { spaces: 2 });
  await fs.rename(tmpPath, profilesPath);
}

export function getProfileConfigDir(name: string): string {
  const home = os.homedir();
  return path.join(home, `.claude-${name}`);
}

export interface CreateProfileOptions {
  shareStatusline?: boolean;
  shareClaudeMd?: boolean;
  /** Human-friendly description stored on the profile. */
  description?: string;
  /** Lower numbers are tried first when running without an explicit chain. */
  priority?: number;
}

export async function createProfile(
  name: string,
  options: CreateProfileOptions = {}
): Promise<Profile> {
  const { shareStatusline = false, shareClaudeMd = false } = options;
  const config = await loadProfiles();

  if (config.profiles[name]) {
    throw new ClaudeProfilesError(
      `Profile "${name}" already exists`,
      ErrorCode.ALREADY_EXISTS,
      `Use 'claude-profiles profile list' to see existing profiles.`
    );
  }

  const configDir = getProfileConfigDir(name);
  const alias = `claude-${name}`;

  // Atomic directory creation — avoids TOCTOU race between exists-check and mkdir
  try {
    await fs.mkdir(configDir, { recursive: false });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
      throw new ClaudeProfilesError(
        `Profile directory ${configDir} already exists on disk`,
        ErrorCode.ALREADY_EXISTS,
        `Remove it manually or choose a different profile name.`
      );
    }
    throw err;
  }

  // Create symlinks for shared items
  const { claudeConfigDir } = getConfigPaths();
  await createSymlinks(claudeConfigDir, configDir);

  // Optionally symlink statusline.sh from main config
  if (shareStatusline) {
    const sourcePath = path.join(claudeConfigDir, 'statusline.sh');
    const targetPath = path.join(configDir, 'statusline.sh');
    if (await fs.pathExists(sourcePath)) {
      await fs.symlink(sourcePath, targetPath);
    }
  }

  // Handle CLAUDE.md: symlink from main config or create independent file
  const claudeMdPath = path.join(configDir, 'CLAUDE.md');
  const claudeMdSource = path.join(claudeConfigDir, 'CLAUDE.md');
  if (shareClaudeMd && (await fs.pathExists(claudeMdSource))) {
    await fs.symlink(claudeMdSource, claudeMdPath);
  } else {
    await fs.writeFile(
      claudeMdPath,
      `# Claude Code Configuration (${name} profile)\n\nThis file is loaded by Claude Code at the start of every session.\n`
    );
  }

  // Save profile to registry
  const profile: Profile = {
    alias,
    configDir,
  };
  if (options.description) profile.description = options.description;
  if (typeof options.priority === 'number') profile.priority = options.priority;
  config.profiles[name] = profile;
  await saveProfiles(config);

  return profile;
}

export async function createSymlinks(
  sourceDir: string,
  targetDir: string
): Promise<string[]> {
  const created: string[] = [];

  for (const item of SHARED_ITEMS) {
    const sourcePath = path.join(sourceDir, item.name);
    const targetPath = path.join(targetDir, item.name);

    // Only symlink if source exists
    if (!(await fs.pathExists(sourcePath))) {
      continue;
    }

    // Remove existing target if any (shouldn't happen on create, but safe)
    if (await fs.pathExists(targetPath)) {
      await fs.remove(targetPath);
    }

    await fs.symlink(sourcePath, targetPath);
    created.push(item.name);
  }

  return created;
}

export async function refreshSymlinks(name: string): Promise<string[]> {
  const config = await loadProfiles();
  const profile = config.profiles[name];

  if (!profile) {
    throw new ClaudeProfilesError(
      `Profile "${name}" not found`,
      ErrorCode.NOT_INITIALIZED,
      `Use 'claude-profiles profile list' to see existing profiles.`
    );
  }

  const { claudeConfigDir } = getConfigPaths();
  return createSymlinks(claudeConfigDir, profile.configDir);
}

export async function deleteProfile(name: string): Promise<Profile> {
  const config = await loadProfiles();
  const profile = config.profiles[name];

  if (!profile) {
    throw new ClaudeProfilesError(
      `Profile "${name}" not found`,
      ErrorCode.NOT_INITIALIZED,
      `Use 'claude-profiles profile list' to see existing profiles.`
    );
  }

  // Remove profile directory
  if (await fs.pathExists(profile.configDir)) {
    await fs.remove(profile.configDir);
  }

  // Remove from registry
  delete config.profiles[name];
  await saveProfiles(config);

  return profile;
}

// Marker comment written above each managed alias. We always write the new
// `claude-profiles` marker, but match the legacy `jean-claude` one too so old
// installs are still recognised and cleaned up.
const PROFILE_MARKER = 'claude-profiles profile';
const CHAIN_MARKER = 'claude-profiles chain';
const MARKER_BRANDS = '(?:jean-claude|claude-profiles)';

export function getShellAliasLine(profile: Profile): string {
  return `alias ${profile.alias}='CLAUDE_CONFIG_DIR="${profile.configDir}" claude'`;
}

export function getShellAliasBlock(name: string, profile: Profile): string {
  return `\n# ${PROFILE_MARKER}: ${name}\n${getShellAliasLine(profile)}\n`;
}

/** Alias that runs a fallback chain via the router. */
export function getChainAliasLine(chainName: string): string {
  return `alias claude-${chainName}='claude-profiles run --chain ${chainName} --'`;
}

export function getChainAliasBlock(chainName: string): string {
  return `\n# ${CHAIN_MARKER}: ${chainName}\n${getChainAliasLine(chainName)}\n`;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasRegex(kind: 'profile' | 'chain', name: string): RegExp {
  return new RegExp(
    `\\n# ${MARKER_BRANDS} ${kind}: ${escapeRegExp(name)}\\n[^\\n]+\\n`,
    'g'
  );
}

function markerMatches(
  content: string,
  kind: 'profile' | 'chain',
  name: string
): boolean {
  return new RegExp(`# ${MARKER_BRANDS} ${kind}: ${escapeRegExp(name)}\\n`).test(
    content
  );
}

async function installAliasBlock(
  kind: 'profile' | 'chain',
  name: string,
  block: string,
  shellConfigFile: string
): Promise<void> {
  const rcPath = path.join(os.homedir(), shellConfigFile);

  if (await fs.pathExists(rcPath)) {
    const content = await fs.readFile(rcPath, 'utf-8');
    if (markerMatches(content, kind, name)) {
      const updated = content.replace(aliasRegex(kind, name), block);
      await fs.writeFile(rcPath, updated);
      return;
    }
  }

  await fs.appendFile(rcPath, block);
}

async function removeAliasBlock(
  kind: 'profile' | 'chain',
  name: string,
  shellConfigFile: string
): Promise<boolean> {
  const rcPath = path.join(os.homedir(), shellConfigFile);
  if (!(await fs.pathExists(rcPath))) return false;

  const content = await fs.readFile(rcPath, 'utf-8');
  if (!markerMatches(content, kind, name)) return false;

  const updated = content.replace(aliasRegex(kind, name), '\n');
  await fs.writeFile(rcPath, updated);
  return true;
}

export async function installShellAlias(
  name: string,
  profile: Profile,
  shellConfigFile: string
): Promise<void> {
  await installAliasBlock(
    'profile',
    name,
    getShellAliasBlock(name, profile),
    shellConfigFile
  );
}

export async function removeShellAlias(
  name: string,
  shellConfigFile: string
): Promise<boolean> {
  return removeAliasBlock('profile', name, shellConfigFile);
}

export async function installChainAlias(
  chainName: string,
  shellConfigFile: string
): Promise<void> {
  await installAliasBlock(
    'chain',
    chainName,
    getChainAliasBlock(chainName),
    shellConfigFile
  );
}

export async function removeChainAlias(
  chainName: string,
  shellConfigFile: string
): Promise<boolean> {
  return removeAliasBlock('chain', chainName, shellConfigFile);
}

export function detectShellConfigFiles(): Array<{ name: string; value: string }> {
  const home = os.homedir();
  const options: Array<{ name: string; value: string }> = [];

  if (fs.existsSync(path.join(home, '.zshrc'))) {
    options.push({ name: '.zshrc (zsh)', value: '.zshrc' });
  }
  if (fs.existsSync(path.join(home, '.bashrc'))) {
    options.push({ name: '.bashrc (bash)', value: '.bashrc' });
  }
  if (fs.existsSync(path.join(home, '.bash_profile'))) {
    options.push({ name: '.bash_profile (bash)', value: '.bash_profile' });
  }

  // Always offer these even if they don't exist yet
  if (!options.some((o) => o.value === '.zshrc')) {
    options.push({ name: '.zshrc (zsh) - will be created', value: '.zshrc' });
  }
  if (!options.some((o) => o.value === '.bashrc')) {
    options.push({
      name: '.bashrc (bash) - will be created',
      value: '.bashrc',
    });
  }

  return options;
}

// ---------------------------------------------------------------------------
// Fallback chains — ordered lists of profiles tried in turn by `run`.
// ---------------------------------------------------------------------------

function assertProfilesExist(config: ProfileConfig, names: string[]): void {
  const missing = names.filter((n) => !config.profiles[n]);
  if (missing.length > 0) {
    throw new ClaudeProfilesError(
      `Unknown profile(s): ${missing.join(', ')}`,
      ErrorCode.NOT_INITIALIZED,
      `Create them first, or run 'claude-profiles profile list'.`
    );
  }
}

export async function createChain(
  name: string,
  profileNames: string[]
): Promise<string[]> {
  if (profileNames.length === 0) {
    throw new ClaudeProfilesError(
      `Chain "${name}" needs at least one profile`,
      ErrorCode.INVALID_CONFIG,
      `Pass --profiles a,b,c`
    );
  }
  const config = await loadProfiles();
  assertProfilesExist(config, profileNames);
  config.chains = config.chains ?? {};
  config.chains[name] = profileNames;
  await saveProfiles(config);
  return profileNames;
}

export async function deleteChain(name: string): Promise<void> {
  const config = await loadProfiles();
  if (!config.chains?.[name]) {
    throw new ClaudeProfilesError(
      `Chain "${name}" not found`,
      ErrorCode.NO_CHAIN,
      `Run 'claude-profiles chain list' to see existing chains.`
    );
  }
  delete config.chains[name];
  await saveProfiles(config);
}

export async function addToChain(
  name: string,
  profileName: string
): Promise<string[]> {
  const config = await loadProfiles();
  assertProfilesExist(config, [profileName]);
  config.chains = config.chains ?? {};
  const chain = config.chains[name] ?? [];
  if (!chain.includes(profileName)) chain.push(profileName);
  config.chains[name] = chain;
  await saveProfiles(config);
  return chain;
}

export async function removeFromChain(
  name: string,
  profileName: string
): Promise<string[]> {
  const config = await loadProfiles();
  const chain = config.chains?.[name];
  if (!chain) {
    throw new ClaudeProfilesError(
      `Chain "${name}" not found`,
      ErrorCode.NO_CHAIN,
      `Run 'claude-profiles chain list' to see existing chains.`
    );
  }
  const updated = chain.filter((n) => n !== profileName);
  config.chains![name] = updated;
  await saveProfiles(config);
  return updated;
}

export async function getChain(name: string): Promise<string[] | undefined> {
  const config = await loadProfiles();
  return config.chains?.[name];
}

export async function listChains(): Promise<Record<string, string[]>> {
  const config = await loadProfiles();
  return config.chains ?? {};
}
