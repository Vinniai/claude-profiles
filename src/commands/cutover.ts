import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadProfiles } from '../lib/profiles.js';
import { profileNameForConfigDir } from '../lib/handoff.js';
import {
  getProfileState,
  setCapOverride,
  clearCapOverride,
  setProfileCooldown,
} from '../lib/state.js';
import { effectivePolicy, upNextForChain } from '../lib/router.js';
import {
  computeCutover,
  effectiveCapPct,
  baseCapPct,
  activeOverride,
  DEFAULT_SESSION_CAP_PCT,
} from '../lib/cutover.js';
import { formatMinutes } from '../lib/statusline-render.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

/**
 * `claude-profiles cutover` — live, in-session control of the routing cutover.
 *
 *   cutover            show the active account's cap, countdown and who's next
 *   cutover push       raise this account's session cap (push into the danger zone)
 *   cutover release    drop the override, restoring the configured cap
 *   cutover now        force a handoff: cool this account so the next launch routes on
 *
 * Designed to be run from inside a session with `! claude-profiles cutover …`,
 * or from any terminal with `--account`. Overrides are written to state.json and
 * picked up by the next statusline render and the next `run`.
 */

type Config = Awaited<ReturnType<typeof loadProfiles>>;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Resolve which account a control applies to: explicit flag, else the env. */
async function resolveAccount(config: Config, explicit?: string): Promise<string> {
  if (explicit) {
    if (!config.profiles[explicit]) {
      throw new ClaudeProfilesError(
        `Profile "${explicit}" not found`,
        ErrorCode.NOT_INITIALIZED,
        `Run 'claude-profiles profile list' to see existing profiles.`,
      );
    }
    return explicit;
  }
  const name = profileNameForConfigDir(
    config.profiles,
    process.env.CLAUDE_CONFIG_DIR,
  );
  if (name) return name;
  throw new ClaudeProfilesError(
    'Could not determine the active account from CLAUDE_CONFIG_DIR',
    ErrorCode.NOT_INITIALIZED,
    'Pass --account <name> (e.g. claude-profiles cutover push --to 95 --account josh).',
  );
}

/** Chain context: explicit flag wins, else the launched-session env. */
function resolveChain(explicit?: string): string | undefined {
  return explicit || process.env.CLAUDE_PROFILES_CHAIN || undefined;
}

/** "in 2h10m" / "at window reset (unknown)" — short expiry label. */
function expiresLabel(untilIso: string | undefined, now: Date): string {
  if (!untilIso) return 'until manually released';
  const mins = (Date.parse(untilIso) - now.getTime()) / 60_000;
  const f = formatMinutes(mins);
  return f && f !== 'now' ? `expires in ${f}` : 'expired';
}

const pushCmd = new Command('push')
  .description('Raise this account’s session cap — push into the danger zone')
  .option('--to <pct>', 'Set the cap to this used-percent (e.g. 95)')
  .option('--by <pct>', 'Raise the current cap by this many points (default 5)')
  .option('-a, --account <name>', 'Account to push (default: the active one)')
  .option('-c, --chain <name>', 'Chain context for the reset window')
  .action(
    async (opts: { to?: string; by?: string; account?: string; chain?: string }) => {
      const now = new Date();
      const config = await loadProfiles();
      const account = await resolveAccount(config, opts.account);
      const chain = resolveChain(opts.chain);

      const s = await getProfileState(account);
      const policy = effectivePolicy(config, chain, account);
      const currentCap =
        effectiveCapPct(policy, s.capOverride, now) ??
        baseCapPct(policy) ??
        DEFAULT_SESSION_CAP_PCT;

      let newCap: number;
      if (opts.to != null) {
        newCap = Number(opts.to);
      } else {
        const by = opts.by != null ? Number(opts.by) : 5;
        newCap = currentCap + by;
      }
      if (!Number.isFinite(newCap)) {
        throw new ClaudeProfilesError(
          'Cap must be a number',
          ErrorCode.INVALID_CONFIG,
          'Example: claude-profiles cutover push --to 95',
        );
      }
      newCap = Math.max(0, Math.min(100, Math.round(newCap)));

      // Expire at the session window's reset so the push never outlives its
      // window; fall back to +5h when the reset isn't known yet.
      const reset = s.usage?.session?.resetAt;
      const until =
        reset && Date.parse(reset) > now.getTime()
          ? reset
          : new Date(now.getTime() + FIVE_HOURS_MS).toISOString();

      await setCapOverride(account, {
        sessionCapPct: newCap,
        until,
        setAt: now.toISOString(),
      });

      const dir = newCap >= currentCap ? 'raised' : 'lowered';
      logger.success(
        `${chalk.bold(account)} session cap ${dir} ${currentCap}% → ${chalk.yellow(`${newCap}%`)}`,
      );
      logger.dim(`${expiresLabel(until, now)} · clear early with: claude-profiles cutover release`);
      if (newCap >= 95) {
        logger.dim('Danger zone: routing will keep using this account until it’s nearly spent.');
      }
    },
  );

const releaseCmd = new Command('release')
  .description('Drop the cap override, restoring the configured cap')
  .option('-a, --account <name>', 'Account to release (default: the active one)')
  .action(async (opts: { account?: string }) => {
    const config = await loadProfiles();
    const account = await resolveAccount(config, opts.account);
    const s = await getProfileState(account);
    if (!s.capOverride) {
      logger.info(`No cap override set for "${account}".`);
      return;
    }
    await clearCapOverride(account);
    logger.success(`Cleared cap override for ${chalk.bold(account)} — back to the configured cap.`);
  });

const nowCmd = new Command('now')
  .description('Force a cutover: cool this account so the next launch routes onward')
  .option('-a, --account <name>', 'Account to cut over from (default: the active one)')
  .option('-c, --chain <name>', 'Chain to compute the next account from')
  .action(async (opts: { account?: string; chain?: string }) => {
    const now = new Date();
    const config = await loadProfiles();
    const account = await resolveAccount(config, opts.account);
    const chain = resolveChain(opts.chain);

    const s = await getProfileState(account);
    const reset = s.usage?.session?.resetAt;
    const until =
      reset && Date.parse(reset) > now.getTime()
        ? new Date(reset)
        : new Date(now.getTime() + 60 * 60 * 1000); // +1h default

    await setProfileCooldown(account, until, 'manual cutover', now, 'manual');

    const next = await upNextForChain({ config, chain, account, now });
    logger.success(
      `Cut over from ${chalk.bold(account)} — cooled ${expiresLabel(until.toISOString(), now)}.`,
    );
    if (next?.name) {
      const rem =
        next.remainingPct != null ? chalk.dim(` (${next.remainingPct}% left)`) : '';
      logger.info(`Up next: ${chalk.cyan(next.name)}${rem}`);
    } else {
      logger.warn('No other healthy account to route to — the chain is exhausted.');
    }
    const relaunch = chain ? `claude-${chain}` : 'claude-profiles run --profile <next> --';
    logger.dim(
      `Relaunch to resume on the next account: ${chalk.cyan(relaunch)} ` +
        '(context is staged at the next compaction).',
    );
  });

const statusCmd = new Command('status')
  .description('Show the active account’s cap, countdown and who’s next')
  .option('-a, --account <name>', 'Account to inspect (default: the active one)')
  .option('-c, --chain <name>', 'Chain context')
  .action(async (opts: { account?: string; chain?: string }) => {
    const now = new Date();
    const config = await loadProfiles();
    const account = await resolveAccount(config, opts.account);
    const chain = resolveChain(opts.chain);

    const s = await getProfileState(account);
    const policy = effectivePolicy(config, chain, account);
    const cutover = computeCutover({
      session: s.usage?.session,
      policy,
      override: s.capOverride,
      burn: s.burn,
      now,
    });
    const next = await upNextForChain({ config, chain, account, now });

    logger.heading(`Cutover — ${account}${chain ? ` · chain "${chain}"` : ''}`);
    console.log();

    const used = cutover.usedPct != null ? `${cutover.usedPct}%` : '?';
    const cap = cutover.capPct != null ? `${cutover.capPct}%` : 'none';
    const ov = activeOverride(s.capOverride, now);
    logger.table([
      ['used', used],
      ['cap', cutover.overridden ? chalk.yellow(`${cap} (pushed)`) : cap],
    ]);
    if (ov) logger.dim(`  override ${expiresLabel(ov.until, now)}`);

    if (cutover.overCap) {
      logger.warn(`Over cap — handoff staged${next?.name ? ` → ${next.name}` : ''}.`);
    } else if (cutover.etaMin != null || cutover.etaTurns != null) {
      const bits = [
        cutover.etaMin != null ? `~${formatMinutes(cutover.etaMin)}` : undefined,
        cutover.etaTurns != null ? `~${cutover.etaTurns} turns` : undefined,
      ].filter(Boolean);
      logger.info(`Cutover in ${bits.join(' / ')}${next?.name ? ` → ${chalk.cyan(next.name)}` : ''}`);
    } else if (next?.name) {
      logger.info(`Up next: ${chalk.cyan(next.name)}`);
    }
  });

export const cutoverCommand = new Command('cutover')
  .description('Live cutover controls: cap, countdown, push past the limit, force handoff')
  .addCommand(statusCmd, { isDefault: true })
  .addCommand(pushCmd)
  .addCommand(releaseCmd)
  .addCommand(nowCmd);
