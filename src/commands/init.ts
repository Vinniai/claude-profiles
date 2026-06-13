import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { logger, formatPath } from '../utils/logger.js';
import { confirm } from '../utils/prompts.js';
import { getConfigPaths, ensureDir } from '../lib/paths.js';
import {
  createMetaJson,
  writeMetaJson,
} from '../lib/sync.js';
import { setupGitSync } from '../lib/sync-setup.js';
import { printLogo } from '../utils/logo.js';

export const initCommand = new Command('init')
  .description('Initialize claude-profiles on this machine')
  .option('--sync', 'Set up Git-based syncing without prompting')
  .option('--no-sync', 'Skip Git sync setup without prompting')
  .option('--url <repo-url>', 'Repository URL for sync setup (implies --sync)')
  .action(async (options: { sync?: boolean; url?: string }) => {
    const { claudeProfilesDir, claudeConfigDir } = getConfigPaths();

    printLogo();
    logger.heading('Setup');

    // Check if already initialized
    const metaPath = path.join(claudeProfilesDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      logger.success(`Already initialized at ${formatPath(claudeProfilesDir)}`);
      logger.dim('Run "claude-profiles sync status" to see current state.');
      return;
    }

    // Create the claude-profiles directory and meta.json
    ensureDir(claudeProfilesDir);
    const meta = createMetaJson(claudeConfigDir);
    await writeMetaJson(claudeProfilesDir, meta);

    // Check for existing git repo (partial init recovery)
    const gitDir = path.join(claudeProfilesDir, '.git');
    if (fs.existsSync(gitDir)) {
      logger.info('Found existing Git repository — reusing it.');
    }

    let wantSync: boolean;
    if (options.url) {
      if (options.sync === false) {
        logger.warn('--url implies --sync; ignoring --no-sync.');
      }
      wantSync = true;
    } else if (options.sync !== undefined) {
      wantSync = options.sync;
    } else {
      console.log('');
      wantSync = await confirm('Would you like to set up syncing with a Git remote?');
    }

    if (wantSync) {
      await setupGitSync(claudeProfilesDir, options.url);
    }

    // Done
    console.log('');
    logger.success('claude-profiles is installed!');
    console.log('');
    logger.dim('Next steps:');

    if (wantSync) {
      logger.list([
        'Run "claude-profiles profile create <name>" to create a profile',
        'Run "claude-profiles sync push" to push your config to Git',
        'Run "claude-profiles sync pull" on other machines to sync',
      ]);
    } else {
      logger.list([
        'Run "claude-profiles profile create <name>" to create a profile',
        'Run "claude-profiles sync setup" to configure syncing later',
      ]);
    }
  });
