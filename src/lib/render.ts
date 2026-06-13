import chalk from 'chalk';
import type {
  UsageWindow,
  UsageBudget,
  RoutingStrategy,
  RoutingEvent,
  RoutingEventKind,
} from '../types/index.js';
import { routingLabel, routingCategory } from './routing-log.js';

export type { UsageWindow, UsageBudget, RoutingStrategy };

// ─── Brand ──────────────────────────────────────────────────────────────────
const orange = chalk.hex('#FF6B4A');

/** Color a routing event by its category so deliberate ≠ automatic at a glance. */
function categoryColor(kind: RoutingEventKind): (s: string) => string {
  const cat = routingCategory(kind);
  if (cat === 'deliberate') return chalk.cyan;
  if (cat === 'auto-failover') return chalk.yellow;
  if (cat === 'exhausted') return chalk.red;
  return orange; // launch
}

/** A colored "glyph label" badge for a routing event kind. */
export function kindBadge(kind: RoutingEventKind): string {
  const { glyph, text } = routingLabel(kind);
  const color = categoryColor(kind);
  return `${color(glyph)} ${color(text)}`;
}

// ─── Local helpers ───────────────────────────────────────────────────────────

/** Strip ANSI escape codes for length measurement. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Remaining percent given a UsageWindow (undefined when usedPct unknown). */
function pctRemaining(w: UsageWindow | undefined): number | undefined {
  if (w?.usedPct == null) return undefined;
  return clamp(100 - w.usedPct, 0, 100);
}

/** "resets in 8m" / "resets in 2h10m" — empty string when unknown. */
function windowEndsLabel(resetAt: string | undefined, now: Date = new Date()): string {
  if (!resetAt) return '';
  const ms = new Date(resetAt).getTime() - now.getTime();
  if (isNaN(ms) || ms <= 0) return '';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h === 0) parts.push(`${m}m`);
  return `resets in ${parts.join('')}`;
}

// ─── 1. budgetBar ────────────────────────────────────────────────────────────

/**
 * A colored meter of REMAINING budget.
 *
 * pct=50, width=12 → `██████░░░░░░ 50%`
 * Unknown pct      → dim `░░░░░░░░░░░░  ?`
 */
export function budgetBar(pct: number | undefined, width = 12): string {
  const empty = '░';
  const fill = '█';

  if (pct == null) {
    return chalk.dim(empty.repeat(width)) + '  ?';
  }

  const clamped = clamp(pct, 0, 100);
  const filled = Math.round((clamped / 100) * width);
  const unfilled = width - filled;

  const bar = fill.repeat(filled) + empty.repeat(unfilled);

  let coloredBar: string;
  if (clamped >= 50) {
    coloredBar = chalk.green(bar);
  } else if (clamped >= 20) {
    coloredBar = chalk.yellow(bar);
  } else {
    coloredBar = chalk.red(bar);
  }

  const label = `${clamped}%`.padStart(5);
  return coloredBar + label;
}

// ─── 2. renderTransition ─────────────────────────────────────────────────────

export interface TransitionOpts {
  from: string;
  to: string | null;
  reason: string;
  /** Why the move happened — drives the marker color + a badge line. */
  kind?: RoutingEventKind;
  fromBudget?: UsageBudget;
  toBudget?: UsageBudget;
}

/**
 * A multi-line boxed "failover card" showing the account switch.
 */
export function renderTransition(opts: TransitionOpts): string {
  const { from, to, reason, kind, fromBudget, toBudget } = opts;
  const now = new Date();

  // ── build visible content lines (no leading/trailing box chars yet) ──
  const contentLines: string[] = [];

  // Header line: marker from ▸▸▸ to. The marker is colored by the move's category so
  // a deliberate switch (cyan) never reads like an automatic failover (yellow).
  // Marker + arrow are width-1 glyphs so the box stays aligned in real terminals.
  const marker = kind ? categoryColor(kind)(routingLabel(kind).glyph) : orange('■');
  const arrow = orange('▸▸▸');
  const toLabel = to == null
    ? chalk.red('(no healthy account left)')
    : chalk.cyan(to);
  const headerLine = `  ${marker} ${chalk.bold(from)}  ${arrow}  ${toLabel}`;
  contentLines.push(headerLine);

  // Kind badge line (deliberate vs auto-failover), when known.
  if (kind) contentLines.push(`  ${kindBadge(kind)}`);

  // Reason line
  contentLines.push(`  reason: ${chalk.dim(reason)}`);

  // Budget lines helper
  function budgetLine(name: string, budget: UsageBudget | undefined): string | null {
    if (!budget) return null;
    const { session, weekly } = budget;
    const parts: string[] = [`  ${name.padEnd(8)}`];

    let hasContent = false;
    if (session != null) {
      const rem = pctRemaining(session);
      parts.push(`session ${budgetBar(rem, 6)}`);
      hasContent = true;
    }
    if (weekly != null) {
      const rem = pctRemaining(weekly);
      parts.push(`weekly ${budgetBar(rem, 6)}`);
      hasContent = true;
    }
    if (!hasContent) return null;

    // Append reset labels to last window
    const resetLabel = session?.resetAt
      ? windowEndsLabel(session.resetAt, now)
      : weekly?.resetAt
        ? windowEndsLabel(weekly.resetAt, now)
        : '';
    if (resetLabel) parts.push(chalk.dim(resetLabel));

    return parts.join('  ');
  }

  const fromLine = budgetLine(from, fromBudget);
  if (fromLine) contentLines.push(fromLine);

  if (to != null) {
    const toLine = budgetLine(to, toBudget);
    if (toLine) contentLines.push(toLine);
  }

  // ── compute box width from longest visible line ──
  const maxVisible = Math.max(...contentLines.map(visibleLen));
  const innerWidth = maxVisible + 2; // 1 space padding each side
  const dim = chalk.dim;

  const top    = dim('╭' + '─'.repeat(innerWidth) + '╮');
  const bottom = dim('╰' + '─'.repeat(innerWidth) + '╯');

  const rows = contentLines.map((line) => {
    const vis = visibleLen(line);
    const pad = innerWidth - 1 - vis; // -1 for the leading space already counted
    return dim('│') + ' ' + line + ' '.repeat(Math.max(0, pad)) + dim('│');
  });

  return [top, ...rows, bottom].join('\n');
}

// ─── 3. renderLaunchBanner ───────────────────────────────────────────────────

export interface LaunchBannerOpts {
  name: string;
  budget?: UsageBudget;
  strategy?: RoutingStrategy;
}

/**
 * A single concise orange line, e.g.
 * `▸ launching claude · profile "josh" · session 20% · weekly 80% · strategy round-robin`
 */
export function renderLaunchBanner(opts: LaunchBannerOpts): string {
  const { name, budget, strategy } = opts;
  const parts: string[] = [];

  parts.push(orange('▸') + ' launching claude');
  parts.push(`profile "${chalk.bold(name)}"`);

  if (budget?.session?.usedPct != null) {
    const rem = pctRemaining(budget.session);
    parts.push(`session ${rem}%`);
  }

  if (budget?.weekly?.usedPct != null) {
    const rem = pctRemaining(budget.weekly);
    parts.push(`weekly ${rem}%`);
  }

  if (strategy) {
    parts.push(`strategy ${chalk.cyan(strategy)}`);
  }

  return parts.join(chalk.dim(' · '));
}

// ─── 4. renderStatusDashboard ────────────────────────────────────────────────

export interface StatusRow {
  name: string;
  status: 'healthy' | 'cooling' | 'auth';
  detail?: string;
  description?: string;
  /** Why the profile was last cooled/flagged — drives a deliberate vs auto badge. */
  kind?: RoutingEventKind;
  session?: UsageWindow;
  weekly?: UsageWindow;
}

/**
 * The body for an upgraded `chain status`.
 */
export function renderStatusDashboard(rows: StatusRow[]): string {
  const now = new Date();
  const blocks: string[] = [];

  for (const row of rows) {
    const lines: string[] = [];

    // Name line
    const desc = row.description ? chalk.dim(` — ${row.description}`) : '';
    lines.push(orange('■') + ' ' + chalk.bold(row.name) + desc);

    // Status line
    let statusStr: string;
    if (row.status === 'healthy') {
      statusStr = chalk.green('healthy');
    } else if (row.status === 'cooling') {
      const detail = row.detail ? chalk.dim(` — ${row.detail}`) : '';
      statusStr = chalk.yellow('cooling down') + detail;
    } else {
      const detail = row.detail ? chalk.dim(` — ${row.detail}`) : '';
      statusStr = chalk.red('needs auth') + detail;
    }
    lines.push(`  status   ${statusStr}`);

    // Why it's down: label a deliberate switch distinctly from an auto-failover.
    if (row.status !== 'healthy' && row.kind) {
      lines.push(`  via      ${kindBadge(row.kind)}`);
    }

    // Session budget line
    if (row.session != null) {
      const rem = pctRemaining(row.session);
      const resetLabel = windowEndsLabel(row.session.resetAt, now);
      const resetPart = resetLabel ? `  ${chalk.dim(resetLabel)}` : '';
      lines.push(`  session  ${budgetBar(rem)}${resetPart}`);
    }

    // Weekly budget line
    if (row.weekly != null) {
      const rem = pctRemaining(row.weekly);
      const resetLabel = windowEndsLabel(row.weekly.resetAt, now);
      const resetPart = resetLabel ? `  ${chalk.dim(resetLabel)}` : '';
      lines.push(`  weekly   ${budgetBar(rem)}${resetPart}`);
    }

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

// ─── 5. renderRoutingLog ─────────────────────────────────────────────────────

/** "3m ago" / "2h ago" / "5d ago" — short relative age, or "just now". */
function agoLabel(at: string, now: Date): string {
  const ms = now.getTime() - new Date(at).getTime();
  if (isNaN(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * One line in the routing-log timeline, e.g.
 * `◆ manual switch   josh ▸▸▸ lockie   3m ago   reason…`
 */
export function formatRoutingEvent(ev: RoutingEvent, now: Date = new Date()): string {
  const badge = kindBadge(ev.kind);
  const arrow = orange('▸▸▸');
  const route =
    ev.from && ev.to
      ? `${chalk.bold(ev.from)} ${arrow} ${chalk.cyan(ev.to)}`
      : ev.to
        ? `${arrow} ${chalk.cyan(ev.to)}`
        : ev.from
          ? `${chalk.bold(ev.from)} ${arrow} ${chalk.red('(none)')}`
          : '';
  const parts = [badge];
  if (route) parts.push(route);
  const ago = agoLabel(ev.at, now);
  if (ago) parts.push(chalk.dim(ago));
  if (ev.chain) parts.push(chalk.dim(`[${ev.chain}]`));
  if (ev.reason) parts.push(chalk.dim(`— ${ev.reason}`));
  return parts.join('  ');
}

/** Render the routing-log timeline as newline-joined lines (newest last). */
export function renderRoutingLog(events: RoutingEvent[], now: Date = new Date()): string {
  if (events.length === 0) return chalk.dim('No routing history yet.');
  return events.map((ev) => formatRoutingEvent(ev, now)).join('\n');
}

// ─── 6. Impure thin wrappers ─────────────────────────────────────────────────

export function printTransition(opts: TransitionOpts): void {
  console.log(renderTransition(opts));
}

export function printLaunchBanner(opts: LaunchBannerOpts): void {
  console.log(renderLaunchBanner(opts));
}

export function printStatusDashboard(rows: StatusRow[]): void {
  console.log(renderStatusDashboard(rows));
}

export function printRoutingLog(events: RoutingEvent[], now: Date = new Date()): void {
  console.log(renderRoutingLog(events, now));
}
