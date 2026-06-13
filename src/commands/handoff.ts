import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import {
  listHandoffs,
  clearHandoff,
  clearAllHandoffs,
} from '../lib/handoff.js';
import {
  installHooks,
  removeHooks,
  hooksInstalled,
  getSettingsPath,
} from '../lib/hooks-install.js';

const handoffStatusCommand = new Command('status')
  .description('Show stored cross-session context for each chain')
  .action(async () => {
    const installed = await hooksInstalled();
    logger.heading('Continuity');
    console.log();
    logger.table([
      [
        'Hooks',
        installed
          ? chalk.green('installed')
          : chalk.yellow('not installed (run: claude-profiles handoff enable)'),
      ],
    ]);

    const records = await listHandoffs();
    if (records.length === 0) {
      console.log();
      logger.dim('No stored context yet.');
      return;
    }
    console.log();
    logger.heading('Threads');
    console.log();
    for (const r of records) {
      console.log(`  ${chalk.bold(r.chain)}`);
      const rows: [string, string][] = [
        ['Thread', chalk.dim(r.threadId)],
        ['Last profile', r.lastProfile ?? chalk.dim('(none)')],
        ['Updated', chalk.dim(r.updatedAt)],
        [
          'Pending failover',
          r.pendingFailover ? chalk.yellow('yes') : chalk.dim('no'),
        ],
      ];
      if (r.summary) {
        const preview =
          r.summary.length > 120 ? r.summary.slice(0, 120) + ' …' : r.summary;
        rows.push(['Summary', chalk.dim(preview.replace(/\n/g, ' '))]);
      }
      logger.table(rows);
      console.log();
    }
  });

const handoffEnableCommand = new Command('enable')
  .description('Install the continuity hooks into ~/.claude/settings.json')
  .action(async () => {
    await installHooks();
    logger.success(`Continuity hooks installed in ${getSettingsPath()}`);
    logger.dim(
      'They no-op unless a session is launched through a chain, so normal `claude` usage is unaffected.'
    );
  });

const handoffDisableCommand = new Command('disable')
  .description('Remove the continuity hooks from ~/.claude/settings.json')
  .action(async () => {
    const removed = await removeHooks();
    if (removed) {
      logger.success('Continuity hooks removed.');
    } else {
      logger.dim('No continuity hooks were installed.');
    }
  });

const handoffClearCommand = new Command('clear')
  .description('Clear stored context (one chain, or all)')
  .argument('[chain]', 'Chain to clear; omit to clear everything')
  .action(async (chain?: string) => {
    if (chain) {
      await clearHandoff(chain);
      logger.success(`Cleared stored context for "${chain}".`);
    } else {
      await clearAllHandoffs();
      logger.success('Cleared all stored context.');
    }
  });

export const handoffCommand = new Command('handoff')
  .description('Manage cross-session context continuity across failovers')
  .addCommand(handoffStatusCommand)
  .addCommand(handoffEnableCommand)
  .addCommand(handoffDisableCommand)
  .addCommand(handoffClearCommand);
