import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadProfiles } from '../lib/profiles.js';
import {
  buildCandidates,
  runWithFallback,
  runInteractive,
} from '../lib/router.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

interface RunOptions {
  chain?: string;
  profile?: string;
  interactive?: boolean;
  headless?: boolean;
}

/** Headless when `-p`/`--print` is present, unless explicitly overridden. */
function detectMode(
  claudeArgs: string[],
  options: RunOptions
): 'headless' | 'interactive' {
  if (options.headless) return 'headless';
  if (options.interactive) return 'interactive';
  const isPrint = claudeArgs.some((a) => a === '-p' || a === '--print');
  return isPrint ? 'headless' : 'interactive';
}

export const runCommand = new Command('run')
  .description(
    'Run Claude through a profile chain, falling back on limit/auth/server errors'
  )
  .option('-c, --chain <name>', 'Fallback chain to use')
  .option('-p, --profile <name>', 'Use a single named profile (no fallback)')
  .option('--interactive', 'Force interactive mode (launch the TUI)')
  .option('--headless', 'Force headless mode (capture + auto-retry)')
  .argument('[claudeArgs...]', 'Arguments passed straight to `claude` (use -- before them)')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (claudeArgs: string[], options: RunOptions) => {
    const config = await loadProfiles();
    if (Object.keys(config.profiles).length === 0) {
      throw new ClaudeProfilesError(
        'No profiles configured',
        ErrorCode.NOT_INITIALIZED,
        `Create one with 'claude-profiles profile create <name>'.`
      );
    }

    const candidates = await buildCandidates(config, {
      chain: options.chain,
      profile: options.profile,
    });

    if (candidates.length === 0) {
      throw new ClaudeProfilesError(
        'No profiles available to run',
        ErrorCode.ALL_PROFILES_EXHAUSTED,
        `Check 'claude-profiles chain status'.`
      );
    }

    const mode = detectMode(claudeArgs, options);

    if (mode === 'interactive') {
      const chosen = candidates[0];
      if (!chosen.healthy) {
        logger.warn(
          `All profiles are cooling down; launching "${chosen.name}" anyway (its limit may have reset).`
        );
      }
      logger.dim(`Launching Claude with profile "${chosen.name}"…`);
      const code = await runInteractive(chosen, claudeArgs);
      process.exit(code);
    }

    // Headless: capture + auto-retry across the chain.
    const result = await runWithFallback({
      candidates,
      claudeArgs,
      onAttempt: (name, index, total) => {
        logger.dim(`[${index + 1}/${total}] trying profile "${name}"…`);
      },
      onFallback: (name, reason, next) => {
        const tail = next
          ? `falling back → ${chalk.cyan(next)}`
          : 'no more profiles to try';
        logger.warn(`profile "${name}" ${reason}; ${tail}`);
      },
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.succeeded) {
      logger.dim(`(served by profile "${result.succeeded}")`);
      process.exit(result.exitCode);
    }

    // Non-failover failure surfaced from the last attempt.
    process.exit(result.exitCode || 1);
  });
