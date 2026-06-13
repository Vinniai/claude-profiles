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
import { ensureHooksInstalled } from '../lib/hooks-install.js';
import { recentRouting, clearRoutingLog } from '../lib/routing-log.js';
import {
  printStatusDashboard,
  printRoutingLog,
  type StatusRow,
} from '../lib/render.js';
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

      // Out-of-the-box continuity: install the failover/handoff hooks so context
      // carries across accounts. They no-op outside chain-launched sessions.
      try {
        if (await ensureHooksInstalled()) {
          logger.dim('Installed continuity hooks in ~/.claude/settings.json.');
        }
      } catch {
        // Non-fatal — the chain still works without continuity hooks.
      }

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
  .description('Show health + usage budgets (session / weekly) for all profiles')
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

    const rows: StatusRow[] = names.map((name) => {
      const s = state.profiles[name];
      const profile = config.profiles[name];
      let status: StatusRow['status'] = 'healthy';
      let detail: string | undefined;
      if (s && !isHealthy(s, now)) {
        if (s.needsAuth) {
          status = 'auth';
          detail = `run: claude-profiles profile login ${name}`;
        } else {
          status = 'cooling';
          const remaining = cooldownRemainingMs(s, now);
          detail = remaining
            ? `${formatRemaining(remaining)} left${s.lastError ? ` — ${s.lastError}` : ''}`
            : s.lastError;
        }
      }
      return {
        name,
        status,
        detail,
        description: profile.description,
        kind: status === 'healthy' ? undefined : s?.lastEventKind,
        session: s?.usage?.session,
        weekly: s?.usage?.weekly,
      };
    });

    console.log();
    printStatusDashboard(rows);
  });

const chainLogCommand = new Command('log')
  .description('Show the routing history — launches, deliberate switches, failovers')
  .option('-c, --chain <name>', 'Only show events for this chain')
  .option('-n, --limit <n>', 'How many recent events to show', '20')
  .option('--clear', 'Erase the routing history')
  .action(async (options: { chain?: string; limit: string; clear?: boolean }) => {
    if (options.clear) {
      await clearRoutingLog();
      logger.success('Routing history cleared.');
      return;
    }
    const limit = Math.max(1, parseInt(options.limit, 10) || 20);
    const events = await recentRouting(limit, options.chain);
    logger.heading(
      options.chain ? `Routing history — chain "${options.chain}"` : 'Routing history'
    );
    console.log();
    printRoutingLog(events);
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
  .addCommand(chainLogCommand)
  .addCommand(chainResetCommand);
