import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadProfiles } from '../lib/profiles.js';
import {
  buildCandidates,
  runWithFallback,
  runInteractiveWithFailover,
} from '../lib/router.js';
import { ensureHooksInstalled } from '../lib/hooks-install.js';
import { loadHandoff, updateHandoff, newThreadId } from '../lib/handoff.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

interface RunOptions {
  chain?: string;
  profile?: string;
  interactive?: boolean;
  headless?: boolean;
  new?: boolean;
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

/**
 * The chain key used for continuity/handoff. An explicit `--chain` wins; with no
 * selection we use "default" when a default chain exists. A single `--profile`
 * run has no chain, so continuity is disabled for it.
 */
async function resolveChainKey(
  options: RunOptions
): Promise<string | undefined> {
  if (options.profile) return undefined;
  if (options.chain) return options.chain;
  const config = await loadProfiles();
  return config.chains?.default ? 'default' : undefined;
}

export const runCommand = new Command('run')
  .description(
    'Run Claude through a profile chain, falling back on limit/auth/server errors'
  )
  .option('-c, --chain <name>', 'Fallback chain to use')
  .option('-p, --profile <name>', 'Use a single named profile (no fallback)')
  .option('--interactive', 'Force interactive mode (launch the TUI)')
  .option('--headless', 'Force headless mode (capture + auto-retry)')
  .option('--new', 'Start a fresh continuity thread (ignore prior context)')
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
      const chainKey = await resolveChainKey(options);

      // Out-of-the-box continuity: make sure the hooks are installed when a
      // chain is in play so failover snapshots/restores context automatically.
      let threadId: string | undefined;
      if (chainKey) {
        try {
          if (await ensureHooksInstalled()) {
            logger.dim('Installed continuity hooks in ~/.claude/settings.json.');
          }
        } catch {
          // Non-fatal: continuity is best-effort, the launch still proceeds.
        }

        const prior = await loadHandoff(chainKey);
        if (prior && !options.new) {
          // Continue the existing thread (context restored on the next start).
          threadId = prior.threadId;
        } else {
          threadId = newThreadId(chainKey);
          // Reset any stale pending-failover so a fresh start stays fresh.
          await updateHandoff(chainKey, {
            threadId,
            pendingFailover: false,
            summary: options.new ? undefined : prior?.summary,
          });
        }
      }

      const result = await runInteractiveWithFailover({
        candidates,
        claudeArgs,
        chain: chainKey,
        threadId,
        onLaunch: (name, healthy) => {
          if (!healthy) {
            logger.warn(
              `All profiles are cooling down; launching "${name}" anyway (its limit may have reset).`
            );
          }
          logger.dim(`Launching Claude with profile "${name}"…`);
        },
        onRelaunch: (from, to) => {
          logger.warn(
            `profile "${from}" was throttled; relaunching on ${chalk.cyan(
              to
            )} with restored context.`
          );
        },
      });

      process.exit(result.exitCode);
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
