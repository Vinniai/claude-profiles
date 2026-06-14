import chalk from 'chalk';
import type {
  UsageWindow,
  UsageBudget,
  RoutingStrategy,
  RoutingEvent,
  RoutingEventKind,
} from '../types/index.js';
import { routingLabel, routingCategory } from './routing-log.js';
import type { CutoverInfo, DrainInfo, ScheduleInfo } from './cutover.js';
import { formatHour } from './cutover.js';
import { formatMinutes } from './statusline-render.js';
import {
  buildResetTimeline,
  formatSpan,
  type AccountPace,
  type PaceInfo,
  type PaceVerdict,
} from './pace.js';

export type { UsageWindow, UsageBudget, RoutingStrategy };

// ─── Brand ──────────────────────────────────────────────────────────────────
const orange = chalk.hex('#FF6B4A');

/** Color a routing event by its category so deliberate ≠ automatic at a glance. */
function categoryColor(kind: RoutingEventKind): (s: string) => string {
  const cat = routingCategory(kind);
  if (cat === 'deliberate') return chalk.cyan;
  if (cat === 'auto-failover') return chalk.yellow;
  if (cat === 'exhausted') return chalk.red;
  if (cat === 'subagent') return chalk.gray;
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
  /**
   * Live login truth from `claude auth status` (when probed). `undefined` means
   * the status was not checked (offline mode, or `claude` unavailable).
   */
  login?: 'in' | 'out';
  /** Account email, when known from a live probe or the saved config. */
  email?: string;
  /** Normalized plan tier to show alongside the account line. */
  plan?: string;
  /** Cutover countdown (cap, ETA, over-cap) for the session window, when known. */
  cutover?: CutoverInfo;
  /** Conditional "drain the expiring session" rule state, when configured. */
  drain?: DrainInfo;
  /** Conditional "prefer during these hours" rule state, when configured. */
  schedule?: ScheduleInfo;
  /** True when routing would move to this profile next. */
  upNext?: boolean;
  /** Session + weekly efficiency read-out (the "pace"), when usage is known. */
  pace?: AccountPace;
}

/** A compact `· cap90 · ~18m/~6t` (or `· ⚠ OVER cap90`) cutover suffix. */
function cutoverSuffix(c: CutoverInfo | undefined): string {
  if (!c || c.capPct == null) return '';
  const star = c.overridden ? '*' : '';
  if (c.overCap) return '  ' + chalk.red(`⚠ OVER cap${c.capPct}${star}`);
  const bits: string[] = [`cap${c.capPct}${star}`];
  const mins = formatMinutes(c.etaMin);
  const eta: string[] = [];
  if (mins) eta.push(`~${mins}`);
  if (c.etaTurns != null) eta.push(`~${c.etaTurns}t`);
  if (eta.length) bits.push(eta.join('/'));
  return '  ' + chalk.dim(bits.join(' · '));
}

/** The `drain` rule line: condition + current state (active / conserving / idle). */
function drainLine(d: DrainInfo): string {
  const cond =
    `prefer when ≤${d.preferWithinMin}m to reset` +
    (d.weeklyFloorPct != null ? ` & weekly ≥${d.weeklyFloorPct}%` : '');

  if (d.state === 'active') {
    const resets =
      d.windowEndsInMin != null
        ? `  ${chalk.dim(`· window resets in ${Math.round(d.windowEndsInMin)}m`)}`
        : '';
    return `  drain    ${chalk.cyan('▶ ACTIVE — preferred')}${resets}`;
  }
  if (d.state === 'conserving') {
    const wk =
      d.weeklyRemainingPct != null && d.weeklyFloorPct != null
        ? ` — weekly ${Math.round(d.weeklyRemainingPct)}% < ${d.weeklyFloorPct}%`
        : '';
    return `  drain    ${chalk.yellow(`conserving${wk}`)}  ${chalk.dim('· last-resort')}`;
  }
  return `  drain    ${chalk.dim(`${cond}   · idle`)}`;
}

/** The `schedule` rule line: time-of-day window + current state. */
function scheduleLine(s: ScheduleInfo): string {
  const window = `${formatHour(s.hours.start)}–${formatHour(s.hours.end)}`;
  if (s.state === 'active') {
    return `  schedule ${chalk.cyan('▶ ACTIVE — preferred')}  ${chalk.dim(`· ${window}`)}`;
  }
  return `  schedule ${chalk.dim(`prefer ${window}   · idle`)}`;
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
    const nextBadge = row.upNext ? ' ' + chalk.cyan('▶ up next') : '';
    lines.push(orange('■') + ' ' + chalk.bold(row.name) + desc + nextBadge);

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

    // Live account line — login truth + identity, when we probed it.
    if (row.login || row.email || row.plan) {
      const bits: string[] = [];
      if (row.login === 'in') bits.push(chalk.green('logged in'));
      else if (row.login === 'out') bits.push(chalk.red('logged out'));
      const tail = [row.email, row.plan].filter(Boolean).join(' · ');
      if (tail) bits.push(chalk.dim(tail));
      if (bits.length) lines.push(`  account  ${bits.join('  ')}`);
    }

    // Session budget line — with the cutover countdown appended when known.
    if (row.session != null) {
      const rem = pctRemaining(row.session);
      const resetLabel = windowEndsLabel(row.session.resetAt, now);
      const resetPart = resetLabel ? `  ${chalk.dim(resetLabel)}` : '';
      lines.push(`  session  ${budgetBar(rem)}${resetPart}${cutoverSuffix(row.cutover)}`);
    }

    // Weekly budget line
    if (row.weekly != null) {
      const rem = pctRemaining(row.weekly);
      const resetLabel = windowEndsLabel(row.weekly.resetAt, now);
      const resetPart = resetLabel ? `  ${chalk.dim(resetLabel)}` : '';
      lines.push(`  weekly   ${budgetBar(rem)}${resetPart}`);
    }

    // Drain rule line — only when the profile has a drain rule configured.
    if (row.drain) lines.push(drainLine(row.drain));

    // Schedule rule line — only when a time-of-day preference is configured.
    if (row.schedule) lines.push(scheduleLine(row.schedule));

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

// ─── 6. Pace view (reset timeline + efficiency verdict) ──────────────────────

/** Verdict → glyph + color. Shared by the full view and the compact summary. */
function verdictGlyph(v: PaceVerdict): { glyph: string; color: (s: string) => string } {
  switch (v) {
    case 'too-fast':
      return { glyph: '▲', color: chalk.red };
    case 'on-pace':
      return { glyph: '●', color: chalk.green };
    case 'underusing':
      return { glyph: '▽', color: chalk.yellow };
    case 'idle':
      return { glyph: '◌', color: chalk.dim };
    case 'capped':
      return { glyph: '⊘', color: chalk.red };
    default:
      return { glyph: '·', color: chalk.dim };
  }
}

function fmtRate(p: number | undefined): string {
  return p == null ? '?' : p.toFixed(2);
}

/** Session efficiency cell, e.g. `● 0.21%/m (ideal 0.23)` / `◌ idle` / `⊘ capped`. */
function sessionPaceLabel(info: PaceInfo | undefined): string {
  if (!info || info.verdict === 'unknown') return chalk.dim('— n/a');
  const { glyph, color } = verdictGlyph(info.verdict);
  if (info.verdict === 'capped') return color(`${glyph} capped`);
  if (info.verdict === 'idle') return color(`${glyph} idle`);
  const rate = fmtRate(info.actualPctPerMin);
  const ideal =
    info.idealPctPerMin != null ? chalk.dim(` (ideal ${fmtRate(info.idealPctPerMin)})`) : '';
  return color(`${glyph} ${rate}%/m`) + ideal;
}

/** Weekly cell, e.g. `▽ 12% slack` / `● on track` / `▲ ahead` / `⊘ capped`. */
function weeklyPaceLabel(info: PaceInfo | undefined): string {
  if (!info || info.verdict === 'unknown') return chalk.dim('— n/a');
  const { glyph, color } = verdictGlyph(info.verdict);
  if (info.verdict === 'capped') return color(`${glyph} capped`);
  if (info.verdict === 'underusing') {
    const slack = info.leftoverPct != null ? `${Math.round(info.leftoverPct)}% slack` : 'slack';
    return color(`${glyph} ${slack}`);
  }
  if (info.verdict === 'too-fast') return color(`${glyph} ahead`);
  return color(`${glyph} on track`);
}

export interface PaceRecommendation {
  name: string;
  reason?: string;
}

/**
 * The full `claude-profiles pace` view: a shared RESETS timeline (session ▽ /
 * weekly ▼ markers laid on one horizon) stacked above a PACE verdict block and a
 * single "best now" recommendation.
 */
export function renderPaceView(opts: {
  rows: StatusRow[];
  recommendation?: PaceRecommendation;
  now?: Date;
  width?: number;
}): string {
  const now = opts.now ?? new Date();
  const rows = opts.rows;
  if (rows.length === 0) return chalk.dim('No accounts to pace.');

  const width = Math.max(16, opts.width ?? 32);
  const nameWidth = Math.max(6, ...rows.map((r) => r.name.length));
  const out: string[] = [];

  // ── RESETS timeline ──
  const geo = buildResetTimeline({
    accounts: rows.map((r) => ({ name: r.name, session: r.session, weekly: r.weekly })),
    now,
    width,
  });
  const axis = chalk.dim('├' + '─'.repeat(Math.max(0, width - 2)) + '┤');
  const horizonLabel = chalk.dim('+' + formatSpan(geo.horizonMin));
  out.push(
    chalk.bold('RESETS') +
      '  ' +
      ' '.repeat(nameWidth) +
      ' ' +
      chalk.dim('now ') +
      axis +
      ' ' +
      horizonLabel
  );

  const sessColor = chalk.cyan;
  const weekColor = chalk.magenta;
  for (const grow of geo.rows) {
    const cells: string[] = new Array(width).fill(' ');
    const labels: string[] = [];
    // Weekly first so a colliding session marker (the nearer-term constraint) wins the cell.
    const ordered = [...grow.markers].sort((a) => (a.kind === 'weekly' ? -1 : 1));
    for (const m of ordered) {
      const glyph = m.kind === 'session' ? '▽' : '▼';
      const color = m.kind === 'session' ? sessColor : weekColor;
      cells[m.col] = color(glyph);
      labels.push(color(`${glyph}${formatSpan(m.inMin)}`));
    }
    const track = chalk.dim('│') + cells.join('');
    const labelStr = labels.length ? '  ' + labels.join(chalk.dim(' · ')) : '';
    out.push(' ' + chalk.bold(grow.name.padEnd(nameWidth)) + ' ' + track + labelStr);
  }

  // ── PACE verdicts ──
  out.push('');
  out.push(
    chalk.bold('PACE') +
      '  ' +
      chalk.dim('▲ too fast · ● on pace · ▽ underusing · ◌ idle · ⊘ capped')
  );
  const sessCells = rows.map((r) => sessionPaceLabel(r.pace?.session));
  const sessWidth = Math.max(...sessCells.map(visibleLen));
  rows.forEach((r, i) => {
    const sess = sessCells[i];
    const sessPad = ' '.repeat(Math.max(0, sessWidth - visibleLen(sess)));
    const wk = weeklyPaceLabel(r.pace?.weekly);
    const bind = r.pace?.binding ? chalk.dim(`  · ${r.pace.binding}-bound`) : '';
    out.push(
      ' ' +
        chalk.bold(r.name.padEnd(nameWidth)) +
        '  sess ' +
        sess +
        sessPad +
        '   wk ' +
        wk +
        bind
    );
  });

  if (opts.recommendation) {
    const reason = opts.recommendation.reason
      ? chalk.dim(`  (${opts.recommendation.reason})`)
      : '';
    out.push('');
    out.push(' ' + chalk.cyan('→ best now: ') + chalk.cyan.bold(opts.recommendation.name) + reason);
  }

  return out.join('\n');
}

/**
 * A single compact pace line for the landing / chain-status dashboards:
 * `pace  josh ●·▽  lockie ▲·●  trev ◌·▲   → lockie`
 */
export function paceSummaryLine(rows: StatusRow[]): string {
  if (rows.length === 0) return '';
  const cells = rows.map((r) => {
    const sg = verdictGlyph(r.pace?.session?.verdict ?? 'unknown');
    const wg = verdictGlyph(r.pace?.weekly?.verdict ?? 'unknown');
    return `${chalk.bold(r.name)} ${sg.color(sg.glyph)}${chalk.dim('·')}${wg.color(wg.glyph)}`;
  });
  const pick = rows.find((r) => r.upNext);
  const best = pick ? '   ' + chalk.cyan('→ ' + chalk.bold(pick.name)) : '';
  return chalk.dim('pace  ') + cells.join('  ') + best;
}

// ─── 7. Impure thin wrappers ─────────────────────────────────────────────────

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

export function printPaceView(opts: {
  rows: StatusRow[];
  recommendation?: PaceRecommendation;
  now?: Date;
  width?: number;
}): void {
  console.log(renderPaceView(opts));
}
