import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { getClaudeProfilesDir } from './paths.js';
import type { HandoffRecord, RoutingEventKind } from '../types/index.js';

/**
 * Cross-session continuity store. Lives in a SHARED directory outside any single
 * profile (`<claude-profiles>/handoff/<chain>/current.json`) so that a session
 * starting on profile B can pick up where a failed-over session on profile A
 * left off. Each chain has one "thread" at a time; a clean session end leaves no
 * `pendingFailover`, so a fresh launch does not re-inject stale context.
 */

const HANDOFF_DIR = 'handoff';
const CURRENT_FILE = 'current.json';

export function getHandoffDir(): string {
  return path.join(getClaudeProfilesDir(), HANDOFF_DIR);
}

function chainDir(chain: string): string {
  // Guard against path traversal from an unexpected chain name.
  const safe = chain.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(getHandoffDir(), safe);
}

function currentPath(chain: string): string {
  return path.join(chainDir(chain), CURRENT_FILE);
}

export async function loadHandoff(
  chain: string
): Promise<HandoffRecord | null> {
  const p = currentPath(chain);
  if (!(await fs.pathExists(p))) return null;
  try {
    const data = (await fs.readJson(p)) as HandoffRecord;
    if (data && typeof data === 'object' && data.chain) return data;
  } catch {
    // Corrupt handoff is non-critical — treat as absent.
  }
  return null;
}

async function saveHandoff(record: HandoffRecord): Promise<void> {
  const dir = chainDir(record.chain);
  await fs.ensureDir(dir);
  const p = path.join(dir, CURRENT_FILE);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeJson(tmp, record, { spaces: 2 });
  await fs.rename(tmp, p);
}

/** Read-modify-write a chain's handoff record. */
export async function updateHandoff(
  chain: string,
  patch: Partial<HandoffRecord>,
  now: Date = new Date()
): Promise<HandoffRecord> {
  const existing = (await loadHandoff(chain)) ?? {
    chain,
    threadId: newThreadId(chain, now),
    updatedAt: now.toISOString(),
  };
  const merged: HandoffRecord = {
    ...existing,
    ...patch,
    chain,
    updatedAt: now.toISOString(),
  };
  await saveHandoff(merged);
  return merged;
}

/** A proactive auto-switch instruction left by the Stop hook for the supervisor. */
export interface SwitchDirective {
  /** Account to relaunch on. */
  to: string;
  /** Human-readable reason, for the banner + routing log. */
  reason?: string;
  /** Routing-event kind (always `'policy'` today). */
  kind?: RoutingEventKind;
}

/**
 * Read and CLEAR a pending auto-switch directive for a chain. The directive is
 * one-shot: consuming it removes the `pendingSwitch*` fields so the supervisor
 * acts on it exactly once. Returns undefined when none is pending.
 */
export async function consumeSwitchDirective(
  chain: string
): Promise<SwitchDirective | undefined> {
  const record = await loadHandoff(chain);
  if (!record?.pendingSwitchTo) return undefined;
  const directive: SwitchDirective = {
    to: record.pendingSwitchTo,
    reason: record.pendingSwitchReason,
    kind: record.pendingSwitchKind,
  };
  // Setting to undefined drops the keys on write (JSON omits undefined), so a
  // later launch won't re-apply a stale switch.
  await updateHandoff(chain, {
    pendingSwitchTo: undefined,
    pendingSwitchReason: undefined,
    pendingSwitchKind: undefined,
  });
  return directive;
}

export async function clearHandoff(chain: string): Promise<void> {
  await fs.remove(chainDir(chain));
}

export async function clearAllHandoffs(): Promise<void> {
  await fs.remove(getHandoffDir());
}

export async function listHandoffs(): Promise<HandoffRecord[]> {
  const dir = getHandoffDir();
  if (!(await fs.pathExists(dir))) return [];
  const entries = await fs.readdir(dir);
  const out: HandoffRecord[] = [];
  for (const name of entries) {
    const rec = await loadHandoff(name);
    if (rec) out.push(rec);
  }
  return out;
}

/** Deterministic-ish thread id without Date.now()/Math.random() footguns. */
export function newThreadId(chain: string, now: Date = new Date()): string {
  return `${chain}-${now.getTime().toString(36)}-${process.pid.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Transcript summarisation — best-effort, never throws.
// ---------------------------------------------------------------------------

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Extract readable text from a Claude Code transcript message content. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Parse a JSONL transcript into ordered user/assistant text turns. */
export function parseTranscript(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = obj.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const message = obj.message as { content?: unknown } | undefined;
    const text = extractText(message?.content).trim();
    if (!text) continue;
    turns.push({ role: type, text });
  }
  return turns;
}

export interface TranscriptSummary {
  summary: string;
  lastAssistantText: string;
  turnCount: number;
}

/**
 * Build a compact, context-injectable summary from a transcript file. Keeps the
 * most recent turns within `maxChars`. Returns empty strings if unreadable.
 */
export async function summarizeTranscript(
  transcriptPath: string | undefined,
  maxChars = 4000
): Promise<TranscriptSummary> {
  if (!transcriptPath) {
    return { summary: '', lastAssistantText: '', turnCount: 0 };
  }
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, 'utf-8');
  } catch {
    return { summary: '', lastAssistantText: '', turnCount: 0 };
  }
  const turns = parseTranscript(raw);
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');

  // Walk backwards accumulating turns until we hit the char budget, then flip.
  const picked: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const label = t.role === 'user' ? 'User' : 'Assistant';
    const snippet = `${label}: ${t.text}`;
    const clipped =
      snippet.length > 1200 ? snippet.slice(0, 1200) + ' …' : snippet;
    if (used + clipped.length > maxChars && picked.length > 0) break;
    picked.push(clipped);
    used += clipped.length;
  }
  picked.reverse();

  return {
    summary: picked.join('\n'),
    lastAssistantText: lastAssistant?.text ?? '',
    turnCount: turns.length,
  };
}

/**
 * The context string injected into a session's SessionStart to continue a prior
 * conversation. Two modes:
 *  - `'failover'` (default): a different account is picking up because the prior
 *    one became unavailable (limit/auth/error).
 *  - `'resume'`: the SAME coordinator/session is reconnecting/relaunching and
 *    continuing its own last conversation (e.g. a remote-control refresh, which
 *    the `claude` CLI cannot `--resume` in server mode).
 */
export function buildContinuationContext(
  record: HandoffRecord,
  mode: 'failover' | 'resume' = 'failover'
): string {
  const from = record.lastProfile ? ` (previously on profile "${record.lastProfile}")` : '';
  const body = record.summary ?? '(no summary captured)';
  if (mode === 'resume') {
    return [
      `You are resuming your previous session on the "${record.chain}" coordinator${from}.`,
      `This is a reconnect/relaunch of the same session — the conversation below is what you were doing before it dropped.`,
      `Pick up exactly where it left off — do not greet the user or restart. Here is the conversation so far:`,
      '',
      body,
    ].join('\n');
  }
  return [
    `You are continuing an in-progress conversation on the "${record.chain}" fallback chain${from}.`,
    `The previous account became unavailable, so this session is resuming it on a different account.`,
    `Pick up exactly where it left off — do not greet the user or restart. Here is the conversation so far:`,
    '',
    body,
  ].join('\n');
}

/** Map an active CLAUDE_CONFIG_DIR back to a profile name via profiles.json. */
export function profileNameForConfigDir(
  profiles: Record<string, { configDir: string }>,
  configDir: string | undefined
): string | undefined {
  if (!configDir) return undefined;
  const norm = path.resolve(configDir.replace(/^~(?=$|\/)/, os.homedir()));
  for (const [name, p] of Object.entries(profiles)) {
    if (path.resolve(p.configDir) === norm) return name;
  }
  return undefined;
}
