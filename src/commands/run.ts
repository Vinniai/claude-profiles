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
import { recordUsage, markUsed } from '../lib/state.js';
import { parseUsageFromText } from '../lib/usage.js';
import { appendRoutingEvent, flushRoutingLog } from '../lib/routing-log.js';
import { printTransition, printLaunchBanner } from '../lib/render.js';
import { parseProfilesSpec } from '../lib/profile-spec.js';
import {
  ClaudeProfilesError,
  ErrorCode,
  ROUTING_STRATEGIES,
  type RoutingPolicy,
  type RoutingStrategy,
} from '../types/index.js';

interface RunOptions {
  chain?: string;
  profile?: string;
  profiles?: string;
  interactive?: boolean;
  headless?: boolean;
  new?: boolean;
  strategy?: string;
  failover?: boolean;
  balanced?: boolean;
  weighted?: boolean;
  leastUsed?: boolean;
  mostRemaining?: boolean;
  minSession?: string;
  minWeekly?: string;
}

/** Resolve the one-shot strategy from the shorthand flags (or `--strategy`). */
function resolveStrategyOverride(options: RunOptions): RoutingStrategy | undefined {
  const picks: RoutingStrategy[] = [];
  if (options.failover) picks.push('priority');
  if (options.balanced) picks.push('round-robin');
  if (options.weighted) picks.push('weighted');
  if (options.leastUsed) picks.push('least-used');
  if (options.mostRemaining) picks.push('most-remaining');
  if (options.strategy) {
    if (!ROUTING_STRATEGIES.includes(options.strategy as RoutingStrategy)) {
      throw new ClaudeProfilesError(
        `Unknown strategy "${options.strategy}"`,
        ErrorCode.INVALID_CONFIG,
        `Choose one of: ${ROUTING_STRATEGIES.join(', ')}.`
      );
    }
    picks.push(options.strategy as RoutingStrategy);
  }
  const uniq = [...new Set(picks)];
  if (uniq.length > 1) {
    throw new ClaudeProfilesError(
      `Conflicting strategy flags: ${uniq.join(', ')}`,
      ErrorCode.INVALID_CONFIG,
      'Pass only one of --failover/--balanced/--weighted/--least-used/--most-remaining.'
    );
  }
  return uniq[0];
}

/** Build a one-shot policy override from `--min-session`/`--min-weekly`. */
function buildPolicyOverride(options: RunOptions): RoutingPolicy | undefined {
  const policy: RoutingPolicy = {};
  const num = (v: string | undefined, label: string): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    if (Number.isNaN(n) || n < 0) {
      throw new ClaudeProfilesError(
        `Invalid value for ${label}: "${v}"`,
        ErrorCode.INVALID_CONFIG,
        'Provide a non-negative number.'
      );
    }
    return n;
  };
  const ms = num(options.minSession, '--min-session');
  const mw = num(options.minWeekly, '--min-weekly');
  if (ms != null) policy.minSessionRemaining = ms;
  if (mw != null) policy.minWeeklyRemaining = mw;
  return Object.keys(policy).length > 0 ? policy : undefined;
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
  // A single profile or an ad-hoc `--profiles` list is not a saved chain, so it
  // has no continuity thread of its own.
  if (options.profile || options.profiles) return undefined;
  if (options.chain) return options.chain;
  const config = await loadProfiles();
  return config.chains?.default ? 'default' : undefined;
}

/** Best-effort: learn a profile's session/weekly budget from CLI output. */
async function learnUsage(name: string, ...texts: string[]): Promise<void> {
  try {
    const budget = parseUsageFromText(texts.filter(Boolean).join('\n'));
    await recordUsage(name, budget);
  } catch {
    // Usage tracking is purely advisory — never let it break a run.
  }
}

export const runCommand = new Command('run')
  .description(
    'Run Claude through a profile chain, falling back on limit/auth/server errors'
  )
  .option('-c, --chain <name>', 'Fallback chain to use')
  .option('-p, --profile <name>', 'Use a single named profile (no fallback)')
  .option(
    '--profiles <list>',
    'Ad-hoc ordered chain, e.g. josh:3,lockie:1 (no saved chain needed)'
  )
  .option('--interactive', 'Force interactive mode (launch the TUI)')
  .option('--headless', 'Force headless mode (capture + auto-retry)')
  .option('--new', 'Start a fresh continuity thread (ignore prior context)')
  .option('--strategy <name>', `Routing strategy: ${ROUTING_STRATEGIES.join('|')}`)
  .option('--failover', 'Shorthand for --strategy priority (classic order)')
  .option('--balanced', 'Shorthand for --strategy round-robin (even spread)')
  .option('--weighted', 'Shorthand for --strategy weighted (by weight/plan)')
  .option('--least-used', 'Shorthand for --strategy least-used')
  .option('--most-remaining', 'Shorthand for --strategy most-remaining')
  .option('--min-session <pct>', 'One-shot: require ≥ this % session budget left')
  .option('--min-weekly <pct>', 'One-shot: require ≥ this % weekly budget left')
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

    // Ad-hoc chain + inline weights, plus one-shot strategy/policy overrides.
    let strategyOverride = resolveStrategyOverride(options);
    const policyOverride = buildPolicyOverride(options);
    let adHocProfiles: string[] | undefined;
    let weights: Record<string, number> | undefined;
    if (options.profiles) {
      const parsed = parseProfilesSpec(options.profiles);
      adHocProfiles = parsed.names;
      weights = parsed.weights;
      // Inline weights imply the weighted strategy unless one was named.
      if (parsed.hasWeights && !strategyOverride) strategyOverride = 'weighted';
    }

    const mode = detectMode(claudeArgs, options);
    const chainKey = await resolveChainKey(options);

    // Sticky session: on an interactive *continuation* (same thread, not --new),
    // pin the account the conversation last ran on so a load-spreading strategy
    // can't move it and drop context. Resolved before candidate ordering.
    const priorHandoff = chainKey ? await loadHandoff(chainKey) : undefined;
    const stickTo =
      mode === 'interactive' && chainKey && !options.new
        ? priorHandoff?.lastProfile
        : undefined;

    const { candidates, deferred, strategy } = await buildCandidates(config, {
      chain: options.chain,
      profile: options.profile,
      profiles: adHocProfiles,
      weights,
      strategyOverride,
      policyOverride,
      stickTo,
    });

    if (candidates.length === 0) {
      throw new ClaudeProfilesError(
        'No profiles available to run',
        ErrorCode.ALL_PROFILES_EXHAUSTED,
        `Check 'claude-profiles chain status'.`
      );
    }

    // Surface any healthy profiles a policy gate pushed to the back, and why.
    for (const d of deferred) {
      logger.dim(`policy: deferring "${d.name}" — ${d.reasons.join('; ')}`);
    }

    const byName = new Map(candidates.map((c) => [c.name, c]));
    const budgetOf = (name: string | null) =>
      name ? byName.get(name)?.usage : undefined;

    if (mode === 'interactive') {
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

        const prior = priorHandoff;
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

      let loggedLaunch = false;
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
          printLaunchBanner({ name, budget: budgetOf(name), strategy });
          // Round-robin bookkeeping: this account is now the most-recently-used.
          void markUsed(name);
          // Log only the first launch; subsequent profiles are logged as the
          // transition that moved us there (onRelaunch), so we don't double-count.
          if (!loggedLaunch) {
            loggedLaunch = true;
            void appendRoutingEvent({
              kind: 'launch',
              to: name,
              chain: chainKey,
              mode: 'interactive',
              strategy,
            });
          }
        },
        onRelaunch: (from, to, kind, reason) => {
          void appendRoutingEvent({
            kind,
            from,
            to,
            chain: chainKey,
            mode: 'interactive',
            reason,
          });
          printTransition({
            from,
            to,
            kind,
            reason:
              reason ??
              (kind === 'manual'
                ? 'deliberate switch — restoring context on the next account'
                : 'profile throttled — restoring context on the next account'),
            fromBudget: budgetOf(from),
            toBudget: budgetOf(to),
          });
        },
      });

      await flushRoutingLog();
      process.exit(result.exitCode);
    }

    // Headless: capture + auto-retry across the chain.
    const headlessChain = chainKey;
    const result = await runWithFallback({
      candidates,
      claudeArgs,
      onAttempt: (name, index, total) => {
        logger.dim(
          `[${index + 1}/${total}] trying profile "${name}" (${strategy})…`
        );
        // The first account tried is the launch; later ones are logged as the
        // failover that moved us to them (onFallback).
        if (index === 0) {
          void appendRoutingEvent({
            kind: 'launch',
            to: name,
            chain: headlessChain,
            mode: 'headless',
            strategy,
          });
        }
      },
      onFallback: (name, reason, next, kind) => {
        void appendRoutingEvent({
          kind,
          from: name,
          to: next,
          chain: headlessChain,
          mode: 'headless',
          reason,
        });
        printTransition({
          from: name,
          to: next,
          kind,
          reason,
          fromBudget: budgetOf(name),
          toBudget: budgetOf(next),
        });
      },
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    // Learn each account's budget from whatever the CLI told us this run.
    for (const attempt of result.attempts) {
      await learnUsage(attempt.name, attempt.outcome.raw);
    }
    if (result.succeeded) {
      await learnUsage(result.succeeded, result.stdout, result.stderr);
      await markUsed(result.succeeded);
      logger.dim(`(served by profile "${result.succeeded}")`);
      await flushRoutingLog();
      process.exit(result.exitCode);
    }

    // Non-failover failure surfaced from the last attempt.
    await flushRoutingLog();
    process.exit(result.exitCode || 1);
  });
