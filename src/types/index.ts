/**
 * Base error type for all claude-profiles failures.
 *
 * The project was renamed from `jean-claude` to `claude-profiles`, so
 * `ClaudeProfilesError` is the canonical name; `JeanClaudeError` is kept as a
 * deprecated alias so existing imports keep working.
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

/** @deprecated Use `ClaudeProfilesError` instead. */
export const JeanClaudeError = ClaudeProfilesError;

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
  NO_CHAIN = 'NO_CHAIN',
}

export interface ConfigPaths {
  // Storage dir for claude-profiles state (profiles.json, state.json, sync repo).
  // Field name kept for backwards compatibility; the on-disk location is now
  // `<claude>/.claude-profiles` (migrated from the legacy `.jean-claude`).
  jeanClaudeDir: string;
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

export interface Profile {
  alias: string;
  configDir: string;
  /** Human-friendly description, e.g. "work Max account". */
  description?: string;
  /** Lower numbers are tried first when no explicit chain order is given. */
  priority?: number;
}

export interface ProfileConfig {
  profiles: Record<string, Profile>;
  /** Named, ordered fallback chains. Each value is a list of profile names. */
  chains?: Record<string, string[]>;
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
}
