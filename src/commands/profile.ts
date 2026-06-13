import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { logger, formatPath } from '../utils/logger.js';
import { confirm, input, select } from '../utils/prompts.js';
import {
  loadProfiles,
  saveProfiles,
  createProfile,
  deleteProfile,
  getProfileConfigDir,
  getShellAliasLine,
  installShellAlias,
  removeShellAlias,
  detectShellConfigFiles,
  refreshSymlinks,
  addToChain,
  installChainAlias,
  SHARED_ITEMS,
  type CreateProfileOptions,
} from '../lib/profiles.js';
import { getClaudeProfilesDir } from '../lib/paths.js';
import {
  ClaudeProfilesError,
  ErrorCode,
  PLAN_TIERS,
  type PlanTier,
} from '../types/index.js';
import fs from 'fs-extra';

function buildProfileCreate(cmdName: string): Command {
  return new Command(cmdName)
  .description('Create a new Claude Code profile with its own config directory')
  .argument('[name]', 'Profile name (e.g., "work", "personal")')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--shell <file>', 'Shell config file to add alias to (e.g., .zshrc, .bashrc)')
  .option('--share-statusline', 'Share statusline.sh with this profile (symlink)')
  .option('--no-share-statusline', 'Do not share statusline.sh with this profile')
  .option('--share-claude-md', 'Share CLAUDE.md with this profile (symlink)')
  .option('--no-share-claude-md', 'Do not share CLAUDE.md with this profile')
  .option('--description <text>', 'Human-friendly description (e.g. "work Max account")')
  .option('--priority <n>', 'Fallback priority (lower is tried first)', (v) => parseInt(v, 10))
  .option('--plan <tier>', `Subscription tier: ${PLAN_TIERS.join('|')}`)
  .option('--chain <name>', 'Also append this profile to the named fallback chain')
  .action(async (nameArg: string | undefined, options: { yes?: boolean; shell?: string; shareStatusline?: boolean; shareClaudeMd?: boolean; description?: string; priority?: number; plan?: string; chain?: string }) => {
    // Verify claude-profiles is initialized
    const jcDir = getClaudeProfilesDir();
    if (!(await fs.pathExists(jcDir))) {
      throw new ClaudeProfilesError(
        'claude-profiles is not initialized',
        ErrorCode.NOT_INITIALIZED,
        'Run `claude-profiles init` first.'
      );
    }

    // Get profile name
    const name =
      nameArg || (await input('Profile name (e.g., work, personal):'));

    if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new ClaudeProfilesError(
        'Invalid profile name',
        ErrorCode.INVALID_CONFIG,
        'Use lowercase letters, numbers, and hyphens. Must start with a letter.'
      );
    }

    const configDir = getProfileConfigDir(name);

    // Fail early if profile already exists (before prompting for options)
    const existingConfig = await loadProfiles();
    if (existingConfig.profiles[name]) {
      throw new ClaudeProfilesError(
        `Profile "${name}" already exists`,
        ErrorCode.ALREADY_EXISTS,
        `Use 'claude-profiles profile list' to see existing profiles.`
      );
    }
    if (await fs.pathExists(configDir)) {
      throw new ClaudeProfilesError(
        `Profile directory ${configDir} already exists on disk`,
        ErrorCode.ALREADY_EXISTS,
        `Remove it manually or choose a different profile name.`
      );
    }

    logger.heading(`Creating profile: ${name}`);
    console.log();
    logger.table([
      ['Config directory', chalk.cyan(formatPath(configDir))],
      ['Shell alias', chalk.cyan(`claude-${name}`)],
    ]);
    console.log();

    logger.dim('The following items will be symlinked from your main config:');
    logger.list(SHARED_ITEMS.map((i) => i.name));
    console.log();

    // Determine optional sharing preferences
    const createOptions: CreateProfileOptions = {};
    if (options.description) createOptions.description = options.description;
    if (typeof options.priority === 'number' && !Number.isNaN(options.priority)) {
      createOptions.priority = options.priority;
    }
    if (options.plan) {
      if (!PLAN_TIERS.includes(options.plan as PlanTier)) {
        throw new ClaudeProfilesError(
          `Unknown plan "${options.plan}"`,
          ErrorCode.INVALID_CONFIG,
          `Choose one of: ${PLAN_TIERS.join(', ')}.`
        );
      }
      createOptions.plan = options.plan as PlanTier;
    }

    if (options.shareStatusline !== undefined) {
      createOptions.shareStatusline = options.shareStatusline;
    } else if (!options.yes) {
      createOptions.shareStatusline = await confirm(
        'Share your statusline configuration with this profile?'
      );
    }

    if (options.shareClaudeMd !== undefined) {
      createOptions.shareClaudeMd = options.shareClaudeMd;
    } else if (!options.yes) {
      createOptions.shareClaudeMd = await confirm(
        'Share your CLAUDE.md with this profile?'
      );
    }

    if (!createOptions.shareClaudeMd) {
      logger.dim(
        'Profile-specific files (like CLAUDE.md) will be independent.'
      );
      console.log();
    }

    if (!options.yes) {
      const proceed = await confirm('Create this profile?');
      if (!proceed) {
        logger.dim('Cancelled.');
        return;
      }
    }

    // Create profile
    logger.step(1, 3, 'Creating profile directory and symlinks...');
    const profile = await createProfile(name, createOptions);
    logger.success('Profile directory created');

    // Install shell alias
    logger.step(2, 3, 'Installing shell alias...');
    let shellFile: string;
    if (options.shell) {
      shellFile = options.shell;
    } else {
      const shellOptions = detectShellConfigFiles();
      shellFile = await select('Add alias to which shell config?', shellOptions);
    }

    await installShellAlias(name, profile, shellFile);
    logger.success(`Alias added to ~/${shellFile}`);

    // Optionally add this profile to a fallback chain
    if (options.chain) {
      const chain = await addToChain(options.chain, name);
      await installChainAlias(options.chain, shellFile);
      logger.success(
        `Added to chain "${options.chain}": ${chain.join(' → ')}`
      );
    }

    // Done
    logger.step(3, 3, 'Done!');
    console.log();
    logger.heading('Next steps');
    console.log();
    if (createOptions.shareClaudeMd) {
      logger.list([
        `Reload your shell or run: ${chalk.cyan(`source ~/${shellFile}`)}`,
        `Then use ${chalk.cyan(`claude-${name}`)} to launch Claude Code with this profile.`,
        `CLAUDE.md is shared (symlinked) from your main config.`,
      ]);
    } else {
      logger.list([
        `Reload your shell or run: ${chalk.cyan(`source ~/${shellFile}`)}`,
        `Then use ${chalk.cyan(`claude-${name}`)} to launch Claude Code with this profile.`,
        `Edit ${chalk.cyan(formatPath(configDir) + '/CLAUDE.md')} to add profile-specific instructions.`,
      ]);
    }
  });
}

const profileListCommand = new Command('list')
  .description('List all Claude Code profiles')
  .action(async () => {
    const config = await loadProfiles();
    const names = Object.keys(config.profiles);

    if (names.length === 0) {
      logger.dim('No profiles configured.');
      logger.dim('Create one with: claude-profiles create <name>');
      return;
    }

    logger.heading('Profiles');
    console.log();

    for (const name of names) {
      const profile = config.profiles[name];
      const exists = await fs.pathExists(profile.configDir);
      const status = exists
        ? chalk.green('active')
        : chalk.red('missing directory');

      console.log(`  ${chalk.bold(name)}`);
      const rows: [string, string][] = [
        ['Alias', chalk.cyan(profile.alias)],
        ['Config', formatPath(profile.configDir)],
        ['Status', status],
      ];
      if (profile.plan) rows.push(['Plan', chalk.cyan(profile.plan)]);
      if (profile.weight != null) rows.push(['Weight', String(profile.weight)]);
      if (profile.priority != null) rows.push(['Priority', String(profile.priority)]);
      if (profile.description) rows.push(['Description', profile.description]);
      logger.table(rows);

      // Check symlink health
      if (exists) {
        const broken: string[] = [];
        for (const item of SHARED_ITEMS) {
          const itemPath = `${profile.configDir}/${item.name}`;
          try {
            const stat = await fs.lstat(itemPath);
            if (stat.isSymbolicLink()) {
              const target = await fs.readlink(itemPath);
              if (!(await fs.pathExists(target))) {
                broken.push(item.name);
              }
            }
          } catch {
            // Item doesn't exist in profile, that's ok if source doesn't exist either
          }
        }
        if (broken.length > 0) {
          logger.table([
            ['Symlinks', chalk.yellow(`broken: ${broken.join(', ')}`)],
          ]);
        }
      }
      console.log();
    }
  });

const profileDeleteCommand = new Command('delete')
  .description('Delete a Claude Code profile')
  .argument('[name]', 'Profile name to delete')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (nameArg: string | undefined, options: { yes?: boolean }) => {
    const config = await loadProfiles();
    const names = Object.keys(config.profiles);

    if (names.length === 0) {
      logger.dim('No profiles to delete.');
      return;
    }

    const name =
      nameArg ||
      (await select(
        'Which profile to delete?',
        names.map((n) => ({ name: n, value: n }))
      ));

    if (!config.profiles[name]) {
      throw new ClaudeProfilesError(
        `Profile "${name}" not found`,
        ErrorCode.NOT_INITIALIZED,
        `Available profiles: ${names.join(', ')}`
      );
    }

    const profile = config.profiles[name];

    logger.heading(`Delete profile: ${name}`);
    console.log();
    logger.warn(
      `This will remove ${chalk.cyan(formatPath(profile.configDir))} and its contents.`
    );
    logger.warn('Profile-specific files (like CLAUDE.md) will be lost.');
    logger.dim('Shared files in your main ~/.claude/ are not affected (they are the originals).');
    console.log();

    if (!options.yes) {
      const proceed = await confirm('Delete this profile?', false);
      if (!proceed) {
        logger.dim('Cancelled.');
        return;
      }
    }

    // Delete profile
    logger.step(1, 2, 'Removing profile directory...');
    await deleteProfile(name);
    logger.success('Profile deleted');

    // Remove shell alias
    logger.step(2, 2, 'Cleaning up shell aliases...');
    const shellFiles = ['.zshrc', '.bashrc', '.bash_profile'];
    for (const shellFile of shellFiles) {
      const removed = await removeShellAlias(name, shellFile);
      if (removed) {
        logger.success(`Removed alias from ~/${shellFile}`);
      }
    }

    console.log();
    logger.success(`Profile "${name}" has been removed.`);
  });

const profileRefreshCommand = new Command('refresh')
  .description('Refresh symlinks for a profile (useful if new shared files were added)')
  .argument('[name]', 'Profile name to refresh')
  .action(async (nameArg?: string) => {
    const config = await loadProfiles();
    const names = Object.keys(config.profiles);

    if (names.length === 0) {
      logger.dim('No profiles configured.');
      return;
    }

    const name =
      nameArg ||
      (await select(
        'Which profile to refresh?',
        names.map((n) => ({ name: n, value: n }))
      ));

    logger.dim(`Refreshing symlinks for profile "${name}"...`);
    const created = await refreshSymlinks(name);
    logger.success(`Symlinks refreshed: ${created.join(', ')}`);
  });

function buildProfileLogin(cmdName: string): Command {
  return new Command(cmdName)
  .description("Authenticate a profile's OAuth account (runs `claude` in its config dir)")
  .argument('[name]', 'Profile to log in')
  .action(async (nameArg?: string) => {
    const config = await loadProfiles();
    const names = Object.keys(config.profiles);
    if (names.length === 0) {
      logger.dim('No profiles configured.');
      logger.dim('Create one with: claude-profiles create <name>');
      return;
    }

    const name =
      nameArg ||
      (await select(
        'Which profile to log in?',
        names.map((n) => ({ name: n, value: n }))
      ));

    const profile = config.profiles[name];
    if (!profile) {
      throw new ClaudeProfilesError(
        `Profile "${name}" not found`,
        ErrorCode.NOT_INITIALIZED,
        `Available profiles: ${names.join(', ')}`
      );
    }

    logger.dim(
      `Launching Claude for profile "${name}". Use /login inside, then exit.`
    );
    const bin = process.env.CLAUDE_PROFILES_CLAUDE_BIN || 'claude';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['/login'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir },
        stdio: 'inherit',
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(
            new ClaudeProfilesError(
              `Could not find the "${bin}" CLI on your PATH`,
              ErrorCode.CLAUDE_NOT_FOUND,
              'Install Claude Code, or set CLAUDE_PROFILES_CLAUDE_BIN to its path.'
            )
          );
          return;
        }
        reject(err);
      });
      child.on('close', () => resolve());
    });
  });
}

interface ProfileSetOptions {
  weight?: string;
  priority?: string;
  description?: string;
  plan?: string;
}

const profileSetCommand = new Command('set')
  .description("Set a profile's routing attributes (weight, plan, priority, description)")
  .argument('<name>', 'Profile to update')
  .option('--weight <n>', 'Weight for the weighted strategy (positive number)')
  .option('--priority <n>', 'Fallback priority (lower is tried first)')
  .option('--plan <tier>', `Subscription tier: ${PLAN_TIERS.join('|')}`)
  .option('--description <text>', 'Human-friendly description')
  .action(async (name: string, options: ProfileSetOptions) => {
    const config = await loadProfiles();
    const profile = config.profiles[name];
    if (!profile) {
      throw new ClaudeProfilesError(
        `Profile "${name}" not found`,
        ErrorCode.NOT_INITIALIZED,
        `Run 'claude-profiles profile list' to see existing profiles.`
      );
    }

    if (
      options.weight == null &&
      options.priority == null &&
      options.plan == null &&
      options.description == null
    ) {
      throw new ClaudeProfilesError(
        'Nothing to set',
        ErrorCode.INVALID_CONFIG,
        'Pass at least one of --weight, --priority, --plan, --description.'
      );
    }

    if (options.weight != null) {
      const w = Number(options.weight);
      if (!Number.isFinite(w) || w <= 0) {
        throw new ClaudeProfilesError(
          `Invalid --weight: "${options.weight}"`,
          ErrorCode.INVALID_CONFIG,
          'Provide a positive number.'
        );
      }
      profile.weight = w;
    }

    if (options.priority != null) {
      const p = parseInt(options.priority, 10);
      if (Number.isNaN(p)) {
        throw new ClaudeProfilesError(
          `Invalid --priority: "${options.priority}"`,
          ErrorCode.INVALID_CONFIG,
          'Provide an integer (lower is tried first).'
        );
      }
      profile.priority = p;
    }

    if (options.plan != null) {
      if (!PLAN_TIERS.includes(options.plan as PlanTier)) {
        throw new ClaudeProfilesError(
          `Unknown plan "${options.plan}"`,
          ErrorCode.INVALID_CONFIG,
          `Choose one of: ${PLAN_TIERS.join(', ')}.`
        );
      }
      profile.plan = options.plan as PlanTier;
    }

    if (options.description != null) {
      profile.description = options.description;
    }

    await saveProfiles(config);

    logger.success(`Updated profile "${name}".`);
    logger.table([
      ['Plan', profile.plan ? chalk.cyan(profile.plan) : chalk.dim('(unset)')],
      ['Weight', profile.weight != null ? chalk.cyan(String(profile.weight)) : chalk.dim('(plan default)')],
      ['Priority', profile.priority != null ? chalk.cyan(String(profile.priority)) : chalk.dim('(big-first default)')],
      ['Description', profile.description ? profile.description : chalk.dim('(none)')],
    ]);
  });

export const profileCommand = new Command('profile')
  .description('Manage Claude Code profiles for multiple accounts')
  .addCommand(buildProfileCreate('create'))
  .addCommand(profileListCommand)
  .addCommand(profileSetCommand)
  .addCommand(profileDeleteCommand)
  .addCommand(profileRefreshCommand)
  .addCommand(buildProfileLogin('login'));

// Top-level conveniences so you can type `claude-profiles create <name>` and
// `claude-profiles login <name>` directly — no nested `profile` needed. They are
// the same commands, just mounted at the root (the `profile` group stays for
// back-compat and to house list/set/delete/refresh).
export const createCommand = buildProfileCreate('create');
export const loginCommand = buildProfileLogin('login');
