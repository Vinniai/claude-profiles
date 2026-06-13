import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadProfiles } from '../lib/profiles.js';
import { loadState, setUsage, clearUsage } from '../lib/state.js';
import { printStatusDashboard, type StatusRow } from '../lib/render.js';
import { isHealthy, cooldownRemainingMs } from '../lib/state.js';
import {
  scanTranscriptUsage,
  estimateCostUsd,
  SESSION_WINDOW_MS,
  WEEKLY_WINDOW_MS,
  type TokenTotals,
} from '../lib/usage-transcripts.js';
import {
  ClaudeProfilesError,
  ErrorCode,
  type UsageBudget,
  type UsageWindow,
} from '../types/index.js';

/** Compact token count: 1234 → "1.2K", 1_500_000 → "1.5M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** "2h ago" / "3d ago" / "just now" from an ISO timestamp. */
function agoLabel(iso: string | undefined, now: Date): string {
  if (!iso) return 'never';
  const ms = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Top model(s) by token share, e.g. "opus 1.1M, sonnet 120K". */
function topModels(totals: TokenTotals, limit = 2): string {
  const entries = Object.entries(totals.byModel).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';
  return entries
    .slice(0, limit)
    .map(([model, tok]) => {
      // Shorten "claude-opus-4-7" → "opus".
      const short = /opus|sonnet|haiku|fable/i.exec(model)?.[0]?.toLowerCase() ?? model;
      return `${short} ${fmtTokens(tok)}`;
    })
    .join(', ');
}

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

interface UsageReportOptions {
  json?: boolean;
  window?: string;
  weeklyWindow?: string;
}

/** Parse a duration like "5h" / "90m" / "7d" / "2h30m" into milliseconds. */
function parseDurationMs(spec: string): number | undefined {
  const m = spec.trim().toLowerCase().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  return ((days * 24 + hours) * 60 + mins) * 60_000;
}

const usageReportCommand = new Command('report')
  .description(
    'Hard token counts + estimated cost per account, read from Claude’s own session transcripts (TUI and headless)'
  )
  .option('--json', 'Emit machine-readable JSON instead of a table')
  .option('--window <dur>', 'Session window size (e.g. "5h", "90m")')
  .option('--weekly-window <dur>', 'Weekly window size (e.g. "7d")')
  .action(async (options: UsageReportOptions) => {
    const config = await loadProfiles();
    const names = Object.keys(config.profiles);
    if (names.length === 0) {
      logger.dim('No profiles configured.');
      return;
    }

    const now = new Date();
    const sessionWindowMs = options.window
      ? parseDurationMs(options.window)
      : SESSION_WINDOW_MS;
    const weeklyWindowMs = options.weeklyWindow
      ? parseDurationMs(options.weeklyWindow)
      : WEEKLY_WINDOW_MS;
    if (sessionWindowMs === undefined) {
      throw new ClaudeProfilesError(
        `Could not parse --window "${options.window}"`,
        ErrorCode.INVALID_CONFIG,
        'Use a duration like "5h", "90m", or "2h30m".'
      );
    }
    if (weeklyWindowMs === undefined) {
      throw new ClaudeProfilesError(
        `Could not parse --weekly-window "${options.weeklyWindow}"`,
        ErrorCode.INVALID_CONFIG,
        'Use a duration like "7d" or "24h".'
      );
    }

    const reports = await Promise.all(
      names.map(async (name) => {
        const profile = config.profiles[name];
        const usage = await scanTranscriptUsage(profile.configDir, {
          now,
          sessionWindowMs,
          weeklyWindowMs,
        });
        return { name, profile, usage };
      })
    );

    if (options.json) {
      console.log(
        JSON.stringify(
          reports.map((r) => ({
            profile: r.name,
            plan: r.profile.plan,
            session: { ...r.usage.session, estCostUsd: estimateCostUsd(r.usage.session) },
            weekly: { ...r.usage.weekly, estCostUsd: estimateCostUsd(r.usage.weekly) },
            lastActivityAt: r.usage.lastActivityAt ?? null,
          })),
          null,
          2
        )
      );
      return;
    }

    logger.heading('Usage report — measured from session transcripts');
    console.log();
    const fmtH = (ms: number) => `${Math.round(ms / 3_600_000)}h`;
    const fmtD = (ms: number) => `${Math.round(ms / 86_400_000)}d`;
    for (const { name, profile, usage } of reports) {
      const planTail = profile.plan ? chalk.dim(` · ${profile.plan}`) : '';
      const desc = profile.description ? chalk.dim(` — ${profile.description}`) : '';
      console.log(`  ${chalk.bold(name)}${planTail}${desc}`);

      for (const [label, win, totals] of [
        [`session (${fmtH(sessionWindowMs)})`, sessionWindowMs, usage.session],
        [`weekly (${fmtD(weeklyWindowMs)})`, weeklyWindowMs, usage.weekly],
      ] as const) {
        void win;
        const cost = estimateCostUsd(totals);
        const models = topModels(totals);
        const io = totals.inputTokens + totals.outputTokens;
        const parts = [
          chalk.cyan(`${fmtTokens(totals.totalTokens)} tok`.padEnd(10)),
          // input+output is the generated work; the rest is (discounted) cache.
          chalk.dim(`(${fmtTokens(io)} i/o)`.padEnd(11)),
          chalk.dim(`~$${cost.toFixed(2)}`),
        ];
        if (models) parts.push(chalk.dim(`· ${models}`));
        parts.push(chalk.dim(`· ${totals.messages} turns`));
        console.log(`    ${label.padEnd(13)} ${parts.join('  ')}`);
      }
      console.log(
        `    ${'last active'.padEnd(13)} ${chalk.dim(agoLabel(usage.lastActivityAt, now))}`
      );
      console.log();
    }
    logger.dim(
      'Token counts are exact (summed from transcripts); cost is an estimate at list prices.'
    );
  });

export const usageCommand = new Command('usage')
  .description('Inspect and set per-profile session / weekly usage budgets')
  .addCommand(usageReportCommand)
  .addCommand(usageShowCommand)
  .addCommand(usageSetCommand)
  .addCommand(usageClearCommand);
