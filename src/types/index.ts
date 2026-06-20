/**
 * Base error type for all claude-profiles failures.
 *
 * The project was renamed from `jean-claude` to `claude-profiles`.
 * `ClaudeProfilesError` is the canonical name; all code must use it.
 */
export class ClaudeProfilesError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'ClaudeProfilesError';
  }
}

export enum ErrorCode {
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  NOT_GIT_REPO = 'NOT_GIT_REPO',
  NO_REMOTE = 'NO_REMOTE',
  MERGE_CONFLICT = 'MERGE_CONFLICT',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  INVALID_CONFIG = 'INVALID_CONFIG',
  UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  CLONE_FAILED = 'CLONE_FAILED',
  // Routing / fallback
  RATE_LIMITED = 'RATE_LIMITED',
  ALL_PROFILES_EXHAUSTED = 'ALL_PROFILES_EXHAUSTED',
  CLAUDE_NOT_FOUND = 'CLAUDE_NOT_FOUND',
  CODEX_NOT_FOUND = 'CODEX_NOT_FOUND',
  NO_CHAIN = 'NO_CHAIN',
  PROFILE_NOT_FOUND = 'PROFILE_NOT_FOUND',
}

export interface ConfigPaths {
  // Storage dir for claude-profiles state (profiles.json, state.json, sync repo).
  // On-disk location: `<claude>/.claude-profiles` (migrated from legacy `.jean-claude`).
  claudeProfilesDir: string;
  claudeConfigDir: string;
  platform: 'darwin' | 'linux';
}

export interface FileMapping {
  source: string;
  target: string;
  type: 'file' | 'directory';
}

export interface MetaJson {
  version: string;
  managedBy?: string;
  lastSync: string | null;
  machineId: string;
  platform: string;
  claudeConfigPath: string;
}

export interface SyncResult {
  file: string;
  action: 'copied' | 'skipped' | 'created' | 'updated' | 'deleted';
  source: string;
  target: string;
}

export interface GitStatus {
  isRepo: boolean;
  isClean: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  modified: string[];
  untracked: string[];
}

export interface DoctorCheck {
  name: string;
  passed: boolean;
  message: string;
  suggestion?: string;
}

/**
 * Anthropic subscription tiers we understand, ordered by capacity. The values
 * mirror Anthropic's own "×" multipliers relative to a Pro baseline, so they
 * double as the default routing weight for an account on that plan.
 */
export type PlanTier = 'pro' | 'max-5x' | 'max-20x';
export type ProfileProvider = 'claude' | 'codex';
export type ProviderModelMap = Partial<Record<ProfileProvider, string>>;
export type ProviderSkillsMap = Partial<Record<ProfileProvider, string[]>>;

export interface TaskRouteConfig {
  /** Ordered account profiles to try. */
  profiles: string[];
  /** Provider-specific model defaults, e.g. Claude Opus and Codex GPT-5.5. */
  models?: ProviderModelMap;
  /** Skills requested on every provider. */
  skills?: string[];
  /** Additional provider-specific skills. */
  providerSkills?: ProviderSkillsMap;
}

export const PLAN_TIERS: readonly PlanTier[] = ['pro', 'max-5x', 'max-20x'] as const;

/** Relative capacity multiplier per plan (Pro = 1× baseline). */
export const PLAN_CAPACITY: Record<PlanTier, number> = {
  pro: 1,
  'max-5x': 5,
  'max-20x': 20,
};

/**
 * Capacity multiplier for a profile's plan, defaulting to 1 (Pro baseline) when
 * the plan is unknown. Used as the default `weighted` weight and to scale
 * `most-remaining` into absolute headroom.
 */
export function planCapacity(plan?: PlanTier): number {
  return plan ? PLAN_CAPACITY[plan] : 1;
}

export interface Profile {
  alias: string;
  configDir: string;
  /** Runtime launched for this account. Missing means Claude for legacy registries. */
  provider?: ProfileProvider;
  /** Optional native Codex config profile loaded with `codex --profile <name>`. */
  configProfile?: string;
  /** Task labels this account is eligible to receive from the fleet MCP. */
  taskTypes?: string[];
  /** Human-friendly description, e.g. "work Max account". */
  description?: string;
  /** Lower numbers are tried first when no explicit chain order is given. */
  priority?: number;
  /**
   * Per-profile routing eligibility gates. When present these override the
   * chain/global policy for this profile (e.g. "never spend this account below
   * 20% of its weekly budget").
   */
  policy?: RoutingPolicy;
  /**
   * Relative weight for the `weighted` strategy (default 1). Higher weight =
   * picked proportionally more often when several profiles are eligible.
   * When unset, the weight falls back to the account's {@link plan} capacity.
   */
  weight?: number;
  /**
   * Anthropic subscription tier for this account. Feeds two routing decisions
   * automatically: the default `weighted` share (a `max-20x` gets ~4× a
   * `max-5x`), the absolute headroom compared by `most-remaining`, and the
   * implicit "big-first" order when no explicit `priority` is set.
   */
  plan?: PlanTier;
}

export interface ProfileConfig {
  profiles: Record<string, Profile>;
  /** Named, ordered fallback chains. Each value is a list of profile names. */
  chains?: Record<string, string[]>;
  /** Default routing strategy + eligibility policy applied to every chain. */
  routing?: RoutingConfig;
  /** Per-chain routing overrides, keyed by chain name (wins over `routing`). */
  chainRouting?: Record<string, RoutingConfig>;
  /** Named task classes mapped to ordered profile fallbacks for MCP delegation. */
  taskRouting?: Record<string, string[] | TaskRouteConfig>;
  /** Where to forward Claude Code `Notification` hook events (e.g. Discord). */
  notify?: NotifyConfig;
}

/**
 * Forward Claude Code's `Notification` hook events (the "waiting for input" /
 * "needs permission" pings) to an external webhook so they reach your phone.
 * The payload is a Discord-compatible `{ content }` JSON POST, which also works
 * for Slack incoming webhooks and most generic webhook receivers.
 */
export interface NotifyConfig {
  /** Webhook URL to POST notifications to. Unset → notifications are not forwarded. */
  webhookUrl?: string;
  /**
   * Only forward notifications whose message contains one of these substrings
   * (case-insensitive). Omit/empty → forward every notification.
   */
  events?: string[];
}

/**
 * How candidates are ordered once the ineligible ones have been filtered out.
 *
 * - `priority`      — chain order as written (the classic failover behaviour).
 * - `round-robin`   — least-recently-used first, so load spreads evenly.
 * - `least-used`    — lowest session usage % first (drains the freshest account).
 * - `most-remaining`— most session budget/time remaining first.
 * - `weighted`      — random pick biased by each profile's `weight`.
 */
export type RoutingStrategy =
  | 'priority'
  | 'round-robin'
  | 'least-used'
  | 'most-remaining'
  | 'weighted';

export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = [
  'priority',
  'round-robin',
  'least-used',
  'most-remaining',
  'weighted',
] as const;

/**
 * Eligibility gates evaluated against a profile's {@link UsageBudget} before it
 * can be selected. A profile failing any gate is moved to the back of the line
 * (never hard-dropped — a chain must always be able to run something).
 */
export interface RoutingPolicy {
  /** Require at least this percent of the WEEKLY budget remaining (0–100). */
  minWeeklyRemaining?: number;
  /** Require at least this percent of the SESSION budget remaining (0–100). */
  minSessionRemaining?: number;
  /**
   * Skip a profile whose session window resets within this many minutes — avoid
   * starting work on an account that's about to be cut off.
   */
  avoidIfWindowEndsWithinMin?: number;
  /**
   * Prefer a profile whose session window resets within this many minutes — use
   * up a soon-to-reset budget before it's wasted. Applied as an ordering boost.
   */
  preferIfWindowEndsWithinMin?: number;
  /**
   * Prefer this profile during a recurring time-of-day window (local machine
   * time), e.g. `{ start: 21, end: 1 }` to favour it from 9pm until 1am — handy
   * for draining an account whose owner doesn't use it overnight. `start`/`end`
   * are integer hours (0–23); when `start > end` the window wraps past midnight.
   * Applied as an ordering boost, gated by the same eligibility requirements as
   * every other rule.
   */
  preferHours?: HourWindow;
}

/** A recurring local-time window, half-open `[start:00, end:00)`. */
export interface HourWindow {
  /** Hour the window opens (0–23, local time). */
  start: number;
  /** Hour the window closes (0–23, local time). `start > end` wraps midnight. */
  end: number;
}

export interface RoutingConfig {
  strategy?: RoutingStrategy;
  policy?: RoutingPolicy;
  /**
   * Proactively switch accounts at a turn boundary when a routing rule (over-cap,
   * schedule window opening, drain becoming active) favours a different account.
   * Applies to supervised interactive chain sessions. Defaults to ON; set false
   * (or pass `--no-auto-switch`) to keep a session pinned to its launch account.
   */
  autoSwitch?: boolean;
}

/**
 * Why work moved (or started) on an account. We separate **deliberate** moves
 * (`manual` — a user/Claude chose to switch via the channel/`switch_account`)
 * from **automatic** routing failovers (`limit`/`auth`/`server` — triggered by
 * the Claude CLI returning an error). `launch` is the initial strategy-driven
 * selection; `exhausted` means no account was left to try. `policy` is an
 * automatic, proactive switch made at a turn boundary because a routing *rule*
 * (over-cap, schedule window, drain) now favours a different account — not an
 * error, but the router choosing to move work before a limit is hit.
 */
export type RoutingEventKind =
  | 'launch'
  | 'manual'
  | 'limit'
  | 'auth'
  | 'server'
  | 'policy'
  | 'exhausted'
  | 'subagent';

export const ROUTING_EVENT_KINDS: readonly RoutingEventKind[] = [
  'launch',
  'manual',
  'limit',
  'auth',
  'server',
  'policy',
  'exhausted',
  'subagent',
] as const;

/** High-level category used to label events in the UI. */
export type RoutingCategory =
  | 'launch'
  | 'deliberate'
  | 'auto-failover'
  | 'exhausted'
  | 'subagent';

/**
 * One entry in the persisted routing log — the time-series of how work has been
 * routed across accounts. Survives `chain reset` and process boundaries so the
 * history can be recalled across sessions.
 */
export interface RoutingEvent {
  /** ISO timestamp of the event. */
  at: string;
  kind: RoutingEventKind;
  /** Chain this routing happened on (omitted for single-profile runs). */
  chain?: string;
  /** Account work moved off (null/omitted on an initial launch). */
  from?: string | null;
  /** Account work moved to (null when exhausted). */
  to?: string | null;
  /** Launch/headless/interactive mode this happened in. */
  mode?: 'interactive' | 'headless';
  /** Strategy that drove the selection (mainly for `launch`). */
  strategy?: RoutingStrategy;
  /** Human-readable detail (the CLI error, or the manual reason). */
  reason?: string;
}

/**
 * A single rolling usage window. Claude Max enforces a short (~5h) session
 * window and a longer weekly window; we track both per profile. All fields are
 * optional/best-effort — the Claude CLI does not always surface them.
 */
export interface UsageWindow {
  /** Percent of this window's budget already consumed (0–100), if known. */
  usedPct?: number;
  /** ISO timestamp when this window resets. */
  resetAt?: string;
  /** ISO timestamp this observation was recorded (for staleness checks). */
  observedAt?: string;
  /** Where the figure came from: parsed from CLI output, or set by the user. */
  source?: 'observed' | 'manual';
}

/** Per-profile usage budget across both windows. */
export interface UsageBudget {
  /** The short, rolling session window (~5h on Max). */
  session?: UsageWindow;
  /** The weekly window. */
  weekly?: UsageWindow;
}

/**
 * Runtime health for a profile, persisted separately from config so concurrent
 * `run` invocations and config edits never clobber each other.
 */
export interface ProfileRuntimeState {
  /** ISO timestamp; the profile is skipped until this time has passed. */
  cooldownUntil?: string | null;
  /** Last failure reason recorded for this profile. */
  lastError?: string;
  /** ISO timestamp of the last recorded failure. */
  lastErrorAt?: string;
  /** True when the profile's OAuth login is expired/missing and needs re-auth. */
  needsAuth?: boolean;
  /**
   * Why this profile was last put into cooldown / flagged — lets the status UI
   * label a "manual switch" differently from an automatic "limit/auth/server"
   * failover.
   */
  lastEventKind?: RoutingEventKind;
  /**
   * Last known usage budget (session + weekly windows) for this profile, used by
   * the strategic router. Best-effort: populated from CLI output or `usage set`.
   */
  usage?: UsageBudget;
  /** ISO timestamp this profile was last selected — drives `round-robin`. */
  lastUsedAt?: string;
  /**
   * Live "push past the cap" override. Raises this account's effective session
   * cap (e.g. 90 → 95) so routing keeps using it into the danger zone. Keyed to
   * the account and auto-expires at {@link CapOverride.until} (the current 5h
   * window's reset), so it never silently outlives the window it was meant for.
   */
  capOverride?: CapOverride;
  /**
   * Burn-rate estimate derived from successive statusline snapshots — drives the
   * "time/turns until cutover" countdown. Best-effort; absent until two
   * observations exist.
   */
  burn?: BurnRate;
}

/** A temporary, per-account raise of the session cap (the "danger zone" push). */
export interface CapOverride {
  /** New effective session cap, percent used (0–100). */
  sessionCapPct: number;
  /** ISO timestamp the override expires (typically the session window reset). */
  until?: string;
  /** ISO timestamp the override was set, for display. */
  setAt?: string;
}

/** Consumption-rate estimate for the rolling session window. */
export interface BurnRate {
  /** Session usage percent consumed per minute (EWMA-smoothed). */
  sessionPctPerMin?: number;
  /** Session usage percent consumed per meaningful change (≈ per turn). */
  pctPerTurn?: number;
  /** ISO timestamp this estimate was last updated. */
  at?: string;
  /**
   * Slow-moving baseline for the per-minute rate. The statusLine fires on every
   * render (seconds apart), so we measure consumption against this anchor and
   * only advance it once a real ≥1-minute window has elapsed — otherwise rapid
   * re-renders would divide a usage delta by a near-zero time delta.
   */
  anchorPct?: number;
  /** ISO timestamp of the current per-minute measurement anchor. */
  anchorAt?: string;
}

export interface RuntimeStateFile {
  profiles: Record<string, ProfileRuntimeState>;
}

/**
 * Cross-session handoff record for a chain, persisted in the shared
 * `<claude-profiles>/handoff/<chain>/current.json`. It lets a session that
 * starts on one profile pick up the context of a previous session that failed
 * over from another profile on the same chain.
 */
export interface HandoffRecord {
  /** Chain this thread belongs to. */
  chain: string;
  /** Stable id for the conversation thread across profiles. */
  threadId: string;
  /** Profile name that produced the most recent snapshot. */
  lastProfile?: string;
  /** Claude session id of the most recent snapshot. */
  lastSessionId?: string;
  /** Path to the most recent transcript (for re-summarising). */
  transcriptPath?: string;
  /** Best-effort running summary of the conversation so far. */
  summary?: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  /**
   * Set when the last session ended on a failover-eligible error. The next
   * SessionStart injects `summary` as context and clears the flag, and the
   * interactive supervisor uses it to decide whether to relaunch.
   */
  pendingFailover?: boolean;
  /** Failure kind that triggered the pending failover, if any. */
  failoverKind?: string;
  /**
   * One-shot resume directive, set when a coordinator/session is relaunched and
   * should continue its prior conversation. Unlike {@link pendingFailover} this is
   * NOT an error and NOT an account switch — the same account is picking its own
   * last session back up (e.g. after a remote-control reconnect/refresh, which the
   * `claude` CLI cannot `--resume` in server mode). The next SessionStart injects
   * `summary` as context and clears the flag, so only the first new session resumes.
   */
  pendingResume?: boolean;
  /**
   * Proactive auto-switch directive, set by the Stop hook when a routing rule
   * (over-cap / schedule / drain) decides work should move to a different account
   * at this turn boundary. The interactive supervisor reads it after `claude`
   * exits and relaunches on {@link pendingSwitchTo}, then the SessionStart hook
   * restores context. Unlike {@link pendingFailover} this is NOT an error — the
   * current account is still healthy; it is the router pre-empting a limit.
   */
  pendingSwitchTo?: string;
  /** Human-readable reason for the pending switch (e.g. "entered preferred hours"). */
  pendingSwitchReason?: string;
  /** Routing-event kind for the pending switch (always `'policy'` today). */
  pendingSwitchKind?: RoutingEventKind;
}
