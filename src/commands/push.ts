import { Command } from 'commander';
import chalk from 'chalk';
import { handleSyncPush } from './sync.js';

const cmd = new Command('push')
  .description('(deprecated) Use "claude-profiles sync push" instead')
  .action(async () => {
    console.error(
      chalk.yellow('Warning:') +
      ' "claude-profiles push" is deprecated. Use ' +
      chalk.cyan('claude-profiles sync push') +
      ' instead.'
    );
    console.error('');
    await handleSyncPush();
  });

(cmd as unknown as { _hidden: boolean })._hidden = true;
export const pushCommand = cmd;
