import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { select } from '../utils/prompts.js';
import {
  loadProfiles,
  listChains,
  createChain,
  deleteChain,
  addToChain,
  removeFromChain,
  installChainAlias,
  removeChainAlias,
  detectShellConfigFiles,
} from '../lib/profiles.js';
import {
  loadState,
  clearProfileState,
  clearAllState,
  isHealthy,
  cooldownRemainingMs,
} from '../lib/state.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

function parseProfilesList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatRemaining(ms: number): string {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

const chainCreateCommand = new Command('create')
  .description('Create a fallback chain and an optional `claude-<name>` alias')
  .argument('<name>', 'Chain name (e.g. "default")')
  .requiredOption('-p, --profiles <list>', 'Comma-separated profiles, in fallback order')
  .option('--shell <file>', 'Shell config file to add the chain alias to')
  .option('--no-alias', 'Do not install a claude-<name> shell alias')
  .action(
    async (
      name: string,
      options: { profiles: string; shell?: string; alias?: boolean }
    ) => {
      const profiles = parseProfilesList(options.profiles);
      const created = await createChain(name, profiles);
      logger.success(`Chain "${name}" created: ${created.join(' → ')}`);

      if (options.alias === false) return;

      let shellFile = options.shell;
      if (!shellFile) {
        shellFile = await select(
          'Add the chain alias to which shell config?',
          detectShellConfigFiles()
        );
      }
      await installChainAlias(name, shellFile);
      logger.success(
        `Alias ${chalk.cyan(`claude-${name}`)} added to ~/${shellFile}`
      );
      logger.dim(
        `Reload your shell, then run ${chalk.cyan(`claude-${name}`)} to use the chain.`
      );
    }
  );

const chainListCommand = new Command('list')
  .description('List all fallback chains')
  .action(async () => {
    const chains = await listChains();
    const names = Object.keys(chains);
    if (names.length === 0) {
      logger.dim('No chains configured.');
      logger.dim('Create one with: claude-profiles chain create default --profiles a,b,c');
      return;
    }
    logger.heading('Chains');
    console.log();
    for (const name of names) {
      logger.table([[name, chalk.cyan(chains[name].join(' → '))]]);
    }
  });

const chainAddCommand = new Command('add')
  .description('Append a profile to a chain')
  .argument('<name>', 'Chain name')
  .argument('<profile>', 'Profile to append')
  .action(async (name: string, profile: string) => {
    const chain = await addToChain(name, profile);
    logger.success(`Chain "${name}": ${chain.join(' → ')}`);
  });

const chainRemoveCommand = new Command('remove')
  .description('Remove a profile from a chain')
  .argument('<name>', 'Chain name')
  .argument('<profile>', 'Profile to remove')
  .action(async (name: string, profile: string) => {
    const chain = await removeFromChain(name, profile);
    logger.success(`Chain "${name}": ${chain.join(' → ') || '(empty)'}`);
  });

const chainDeleteCommand = new Command('delete')
  .description('Delete a chain and its shell alias')
  .argument('<name>', 'Chain name')
  .action(async (name: string) => {
    await deleteChain(name);
    for (const shellFile of ['.zshrc', '.bashrc', '.bash_profile']) {
      const removed = await removeChainAlias(name, shellFile);
      if (removed) logger.success(`Removed alias from ~/${shellFile}`);
    }
    logger.success(`Chain "${name}" deleted.`);
  });

const chainStatusCommand = new Command('status')
  .description('Show health (cooldowns / needs-auth) for all profiles')
  .action(async () => {
    const config = await loadProfiles();
    const state = await loadState();
    const names = Object.keys(config.profiles);
    if (names.length === 0) {
      logger.dim('No profiles configured.');
      return;
    }
    const now = new Date();
    logger.heading('Profile health');
    console.log();
    for (const name of names) {
      const s = state.profiles[name];
      let status: string;
      if (!s || isHealthy(s, now)) {
        status = chalk.green('healthy');
      } else if (s.needsAuth) {
        status = chalk.red('needs auth (run: claude-profiles profile login ' + name + ')');
      } else {
        const remaining = cooldownRemainingMs(s, now);
        status = chalk.yellow(
          `cooling down${remaining ? ` (${formatRemaining(remaining)} left)` : ''}`
        );
      }
      const rows: [string, string][] = [['Status', status]];
      if (config.profiles[name].description) {
        rows.push(['Description', config.profiles[name].description!]);
      }
      if (s?.lastError) rows.push(['Last error', chalk.dim(s.lastError)]);
      console.log(`  ${chalk.bold(name)}`);
      logger.table(rows);
      console.log();
    }
  });

const chainResetCommand = new Command('reset')
  .description('Clear cooldowns / needs-auth flags (for a profile or all)')
  .argument('[profile]', 'Profile to reset; omit to reset everything')
  .action(async (profile?: string) => {
    if (profile) {
      const config = await loadProfiles();
      if (!config.profiles[profile]) {
        throw new ClaudeProfilesError(
          `Profile "${profile}" not found`,
          ErrorCode.NOT_INITIALIZED,
          `Run 'claude-profiles profile list'.`
        );
      }
      await clearProfileState(profile);
      logger.success(`Cleared runtime state for "${profile}".`);
    } else {
      await clearAllState();
      logger.success('Cleared runtime state for all profiles.');
    }
  });

export const chainCommand = new Command('chain')
  .description('Manage fallback chains across profiles')
  .addCommand(chainCreateCommand)
  .addCommand(chainListCommand)
  .addCommand(chainAddCommand)
  .addCommand(chainRemoveCommand)
  .addCommand(chainDeleteCommand)
  .addCommand(chainStatusCommand)
  .addCommand(chainResetCommand);
