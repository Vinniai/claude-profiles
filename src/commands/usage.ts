import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { loadProfiles } from '../lib/profiles.js';
import { loadState, setUsage, clearUsage } from '../lib/state.js';
import { printStatusDashboard, type StatusRow } from '../lib/render.js';
import { isHealthy, cooldownRemainingMs } from '../lib/state.js';
import {
  ClaudeProfilesError,
  ErrorCode,
  type UsageBudget,
  type UsageWindow,
} from '../types/index.js';

/**
 * Parse a reset spec into an ISO timestamp. Accepts a relative duration
 * (`5h`, `90m`, `3d`, `2h30m`) interpreted from now, or a full ISO string.
 */
function parseResetSpec(spec: string, now: Date = new Date()): string {
  const rel = spec.trim().toLowerCase();
  const durMatch = rel.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (durMatch && (durMatch[1] || durMatch[2] || durMatch[3])) {
    const days = Number(durMatch[1] ?? 0);
    const hours = Number(durMatch[2] ?? 0);
    const mins = Number(durMatch[3] ?? 0);
    const ms = ((days * 24 + hours) * 60 + mins) * 60_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  const asDate = new Date(spec);
  if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  throw new ClaudeProfilesError(
    `Could not parse reset time "${spec}"`,
    ErrorCode.INVALID_CONFIG,
    'Use a duration like "5h", "90m", "2h30m" or an ISO timestamp.'
  );
}

function parsePct(v: string | undefined, label: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Number.isNaN(n) || n < 0 || n > 100) {
    throw new ClaudeProfilesError(
      `Invalid percentage for ${label}: "${v}"`,
      ErrorCode.INVALID_CONFIG,
      'Provide a number between 0 and 100 (percent of the window USED).'
    );
  }
  return n;
}

const usageShowCommand = new Command('show')
  .description('Show each profile’s session / weekly usage budget')
  .action(async () => {
    const config = await loadProfiles();
    const state = await loadState();
    const names = Object.keys(config.profiles);
    if (names.length === 0) {
      logger.dim('No profiles configured.');
      return;
    }
    const now = new Date();
    logger.heading('Usage budgets');
    console.log();
    const rows: StatusRow[] = names.map((name) => {
      const s = state.profiles[name];
      let status: StatusRow['status'] = 'healthy';
      let detail: string | undefined;
      if (s && !isHealthy(s, now)) {
        if (s.needsAuth) {
          status = 'auth';
        } else {
          status = 'cooling';
          const r = cooldownRemainingMs(s, now);
          detail = r ? `${Math.ceil(r / 60000)}m left` : undefined;
        }
      }
      return {
        name,
        status,
        detail,
        description: config.profiles[name].description,
        session: s?.usage?.session,
        weekly: s?.usage?.weekly,
      };
    });
    printStatusDashboard(rows);
    logger.dim(
      'Budgets self-populate from CLI output; override with: claude-profiles usage set <profile> --session <pct> --weekly <pct>'
    );
  });

interface UsageSetOptions {
  session?: string;
  weekly?: string;
  sessionReset?: string;
  weeklyReset?: string;
}

const usageSetCommand = new Command('set')
  .description('Manually set a profile’s usage budget (percent USED, 0–100)')
  .argument('<profile>', 'Profile name')
  .option('--session <pct>', 'Percent of the SESSION window used (0–100)')
  .option('--weekly <pct>', 'Percent of the WEEKLY window used (0–100)')
  .option('--session-reset <when>', 'When the session resets (e.g. "5h" or ISO)')
  .option('--weekly-reset <when>', 'When the weekly window resets (e.g. "3d" or ISO)')
  .action(async (profile: string, options: UsageSetOptions) => {
    const config = await loadProfiles();
    if (!config.profiles[profile]) {
      throw new ClaudeProfilesError(
        `Profile "${profile}" not found`,
        ErrorCode.NOT_INITIALIZED,
        `Run 'claude-profiles profile list'.`
      );
    }
    const now = new Date();
    const state = await loadState();
    const existing = state.profiles[profile]?.usage ?? {};

    const session: UsageWindow | undefined =
      options.session !== undefined || options.sessionReset
        ? {
            ...existing.session,
            usedPct: parsePct(options.session, '--session') ?? existing.session?.usedPct,
            resetAt: options.sessionReset
              ? parseResetSpec(options.sessionReset, now)
              : existing.session?.resetAt,
            observedAt: now.toISOString(),
            source: 'manual',
          }
        : existing.session;

    const weekly: UsageWindow | undefined =
      options.weekly !== undefined || options.weeklyReset
        ? {
            ...existing.weekly,
            usedPct: parsePct(options.weekly, '--weekly') ?? existing.weekly?.usedPct,
            resetAt: options.weeklyReset
              ? parseResetSpec(options.weeklyReset, now)
              : existing.weekly?.resetAt,
            observedAt: now.toISOString(),
            source: 'manual',
          }
        : existing.weekly;

    if (!session && !weekly) {
      throw new ClaudeProfilesError(
        'Nothing to set',
        ErrorCode.INVALID_CONFIG,
        'Pass at least one of --session / --weekly / --session-reset / --weekly-reset.'
      );
    }

    const budget: UsageBudget = {};
    if (session) budget.session = session;
    if (weekly) budget.weekly = weekly;
    await setUsage(profile, budget);
    logger.success(`Updated usage budget for "${profile}".`);
  });

const usageClearCommand = new Command('clear')
  .description('Clear a profile’s stored usage budget')
  .argument('<profile>', 'Profile name')
  .action(async (profile: string) => {
    const config = await loadProfiles();
    if (!config.profiles[profile]) {
      throw new ClaudeProfilesError(
        `Profile "${profile}" not found`,
        ErrorCode.NOT_INITIALIZED,
        `Run 'claude-profiles profile list'.`
      );
    }
    await clearUsage(profile);
    logger.success(`Cleared usage budget for "${profile}".`);
  });

export const usageCommand = new Command('usage')
  .description('Inspect and set per-profile session / weekly usage budgets')
  .addCommand(usageShowCommand)
  .addCommand(usageSetCommand)
  .addCommand(usageClearCommand);
