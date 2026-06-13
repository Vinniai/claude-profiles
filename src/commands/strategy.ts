import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadProfiles, saveProfiles } from '../lib/profiles.js';
import {
  ClaudeProfilesError,
  ErrorCode,
  ROUTING_STRATEGIES,
  type RoutingPolicy,
  type RoutingStrategy,
  type RoutingConfig,
} from '../types/index.js';

const orange = chalk.hex('#FF6B4A');

function assertStrategy(value: string): RoutingStrategy {
  if (!ROUTING_STRATEGIES.includes(value as RoutingStrategy)) {
    throw new ClaudeProfilesError(
      `Unknown strategy "${value}"`,
      ErrorCode.INVALID_CONFIG,
      `Choose one of: ${ROUTING_STRATEGIES.join(', ')}.`
    );
  }
  return value as RoutingStrategy;
}

function describePolicy(p?: RoutingPolicy): string {
  if (!p || Object.keys(p).length === 0) return chalk.dim('(none)');
  const parts: string[] = [];
  if (p.minWeeklyRemaining != null)
    parts.push(`weekly ≥ ${p.minWeeklyRemaining}%`);
  if (p.minSessionRemaining != null)
    parts.push(`session ≥ ${p.minSessionRemaining}%`);
  if (p.avoidIfWindowEndsWithinMin != null)
    parts.push(`avoid if resets < ${p.avoidIfWindowEndsWithinMin}m`);
  if (p.preferIfWindowEndsWithinMin != null)
    parts.push(`prefer if resets < ${p.preferIfWindowEndsWithinMin}m`);
  return parts.join(', ');
}

const strategyShowCommand = new Command('show')
  .description('Show the active routing strategy and eligibility policies')
  .action(async () => {
    const config = await loadProfiles();
    logger.heading('Routing strategy');
    console.log();
    logger.table([
      ['Default', orange(config.routing?.strategy ?? 'priority')],
      ['Default policy', describePolicy(config.routing?.policy)],
    ]);

    const perChain = config.chainRouting ?? {};
    if (Object.keys(perChain).length > 0) {
      console.log();
      logger.heading('Per-chain overrides');
      console.log();
      for (const [chain, rc] of Object.entries(perChain)) {
        console.log(`  ${chalk.bold(chain)}`);
        logger.table([
          ['Strategy', rc.strategy ? orange(rc.strategy) : chalk.dim('(inherit)')],
          ['Policy', describePolicy(rc.policy)],
        ]);
        console.log();
      }
    }

    const perProfile = Object.entries(config.profiles).filter(
      ([, p]) => p.policy && Object.keys(p.policy).length > 0
    );
    if (perProfile.length > 0) {
      logger.heading('Per-profile policies');
      console.log();
      for (const [name, p] of perProfile) {
        logger.table([[name, describePolicy(p.policy)]]);
      }
      console.log();
    }

    logger.dim(`Strategies: ${ROUTING_STRATEGIES.join(', ')}`);
  });

const strategySetCommand = new Command('set')
  .description('Set the routing strategy (globally or for one chain)')
  .argument('<strategy>', `One of: ${ROUTING_STRATEGIES.join(', ')}`)
  .option('-c, --chain <name>', 'Scope to a single chain instead of the default')
  .action(async (value: string, options: { chain?: string }) => {
    const strategy = assertStrategy(value);
    const config = await loadProfiles();

    if (options.chain) {
      if (!config.chains?.[options.chain]) {
        throw new ClaudeProfilesError(
          `Chain "${options.chain}" not found`,
          ErrorCode.NO_CHAIN,
          `Run 'claude-profiles chain list'.`
        );
      }
      config.chainRouting ??= {};
      const rc: RoutingConfig = config.chainRouting[options.chain] ?? {};
      rc.strategy = strategy;
      config.chainRouting[options.chain] = rc;
      await saveProfiles(config);
      logger.success(
        `Chain "${options.chain}" now routes with ${orange(strategy)}.`
      );
      return;
    }

    config.routing ??= {};
    config.routing.strategy = strategy;
    await saveProfiles(config);
    logger.success(`Default routing strategy set to ${orange(strategy)}.`);
  });

interface PolicyOptions {
  chain?: string;
  profile?: string;
  minWeekly?: string;
  minSession?: string;
  avoidWithin?: string;
  preferWithin?: string;
  clear?: boolean;
}

function buildPolicyPatch(options: PolicyOptions): RoutingPolicy {
  const policy: RoutingPolicy = {};
  const num = (v: string | undefined, label: string): number | undefined => {
    if (v === undefined) return undefined;
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
  const mw = num(options.minWeekly, '--min-weekly');
  const ms = num(options.minSession, '--min-session');
  const aw = num(options.avoidWithin, '--avoid-within');
  const pw = num(options.preferWithin, '--prefer-within');
  if (mw != null) policy.minWeeklyRemaining = mw;
  if (ms != null) policy.minSessionRemaining = ms;
  if (aw != null) policy.avoidIfWindowEndsWithinMin = aw;
  if (pw != null) policy.preferIfWindowEndsWithinMin = pw;
  return policy;
}

const strategyPolicyCommand = new Command('policy')
  .description('Set eligibility gates (global, per-chain, or per-profile)')
  .option('-c, --chain <name>', 'Scope to a chain')
  .option('-p, --profile <name>', 'Scope to a single profile')
  .option('--min-weekly <pct>', 'Require ≥ this % of WEEKLY budget remaining')
  .option('--min-session <pct>', 'Require ≥ this % of SESSION budget remaining')
  .option('--avoid-within <min>', 'Skip a profile whose session resets within N minutes')
  .option('--prefer-within <min>', 'Prefer a profile whose session resets within N minutes')
  .option('--clear', 'Remove the policy at the chosen scope')
  .action(async (options: PolicyOptions) => {
    const config = await loadProfiles();

    if (options.chain && options.profile) {
      throw new ClaudeProfilesError(
        'Use either --chain or --profile, not both',
        ErrorCode.INVALID_CONFIG
      );
    }

    // Per-profile scope.
    if (options.profile) {
      const profile = config.profiles[options.profile];
      if (!profile) {
        throw new ClaudeProfilesError(
          `Profile "${options.profile}" not found`,
          ErrorCode.NOT_INITIALIZED,
          `Run 'claude-profiles profile list'.`
        );
      }
      if (options.clear) {
        delete profile.policy;
        await saveProfiles(config);
        logger.success(`Cleared policy for profile "${options.profile}".`);
        return;
      }
      profile.policy = { ...profile.policy, ...buildPolicyPatch(options) };
      await saveProfiles(config);
      logger.success(`Updated policy for profile "${options.profile}".`);
      return;
    }

    // Per-chain scope.
    if (options.chain) {
      if (!config.chains?.[options.chain]) {
        throw new ClaudeProfilesError(
          `Chain "${options.chain}" not found`,
          ErrorCode.NO_CHAIN,
          `Run 'claude-profiles chain list'.`
        );
      }
      config.chainRouting ??= {};
      const rc: RoutingConfig = config.chainRouting[options.chain] ?? {};
      if (options.clear) {
        delete rc.policy;
      } else {
        rc.policy = { ...rc.policy, ...buildPolicyPatch(options) };
      }
      config.chainRouting[options.chain] = rc;
      await saveProfiles(config);
      logger.success(`Updated policy for chain "${options.chain}".`);
      return;
    }

    // Global scope.
    config.routing ??= {};
    if (options.clear) {
      delete config.routing.policy;
    } else {
      config.routing.policy = {
        ...config.routing.policy,
        ...buildPolicyPatch(options),
      };
    }
    await saveProfiles(config);
    logger.success('Updated the default routing policy.');
  });

export const strategyCommand = new Command('strategy')
  .description('Configure how the router picks among healthy profiles')
  .addCommand(strategyShowCommand)
  .addCommand(strategySetCommand)
  .addCommand(strategyPolicyCommand);
