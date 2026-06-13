/**
 * Hard usage numbers, read from Claude Code's own session transcripts.
 *
 * Every assistant turn — whether produced by the interactive TUI or a headless
 * `-p` call — is appended to `<configDir>/projects/<slug>/<sessionId>.jsonl`
 * with a `message.usage` block:
 *
 *   { "type":"assistant", "timestamp":"…",
 *     "message": { "model":"claude-opus-4-7",
 *       "usage": { "input_tokens":…, "output_tokens":…,
 *                  "cache_creation_input_tokens":…, "cache_read_input_tokens":… } } }
 *
 * Summing those per time window gives a real, TUI-inclusive token count per
 * account — no `claude -p` scrape, no telemetry collector. This is the source
 * of truth behind `claude-profiles usage report`.
 *
 * Caveat: if a profile sets `CLAUDE_CODE_SKIP_PROMPT_HISTORY` (or
 * `cleanupPeriodDays` prunes old files) transcripts won't be complete; the scan
 * simply reports what's on disk.
 */

import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { createReadStream } from 'fs';

/** Rolling windows we bucket usage into, in milliseconds. */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000; // ~5h Max session window
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d weekly window

/** Aggregated token counts for one time window. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** input + output + cacheCreation + cacheRead — the headline number. */
  totalTokens: number;
  /** Number of assistant turns counted. */
  messages: number;
  /** Total tokens attributed to each model id. */
  byModel: Record<string, number>;
}

export interface TranscriptUsage {
  /** Usage within the session window (default ~5h). */
  session: TokenTotals;
  /** Usage within the weekly window (default 7d). */
  weekly: TokenTotals;
  /** ISO timestamp of the most recent assistant turn seen, if any. */
  lastActivityAt?: string;
  /** Number of transcript files scanned (after the mtime prefilter). */
  filesScanned: number;
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    messages: 0,
    byModel: {},
  };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function addUsage(totals: TokenTotals, usage: RawUsage, model: string): void {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const sum = input + output + cacheCreate + cacheRead;

  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.cacheCreationTokens += cacheCreate;
  totals.cacheReadTokens += cacheRead;
  totals.totalTokens += sum;
  totals.messages += 1;
  if (model) totals.byModel[model] = (totals.byModel[model] ?? 0) + sum;
}

export interface ScanOptions {
  now?: Date;
  sessionWindowMs?: number;
  weeklyWindowMs?: number;
}

/**
 * List candidate transcript files under `<configDir>/projects`, newest-relevant
 * first, skipping any whose mtime is older than the widest window (so a years-old
 * project costs one `stat`, not a full read).
 */
async function candidateTranscripts(
  projectsDir: string,
  oldestMs: number,
): Promise<string[]> {
  const out: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(projectsDir);
  } catch {
    return out; // no projects dir → no usage on record
  }
  for (const proj of projectDirs) {
    const dir = path.join(projectsDir, proj);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      try {
        const st = await fs.stat(fp);
        // A file last written before the window opened can't hold in-window turns.
        if (st.mtimeMs >= oldestMs) out.push(fp);
      } catch {
        /* ignore unreadable file */
      }
    }
  }
  return out;
}

/** Parse a single transcript line, returning its in-window contribution or null. */
function parseLine(
  line: string,
): { ts: number; usage: RawUsage; model: string } | null {
  // Cheap prefilter: skip lines that can't be an assistant turn with usage.
  if (line.indexOf('"usage"') === -1 || line.indexOf('"assistant"') === -1) {
    return null;
  }
  let obj: {
    type?: string;
    timestamp?: string;
    message?: { role?: string; model?: string; usage?: RawUsage };
  };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj.type !== 'assistant') return null;
  const msg = obj.message;
  if (!msg || msg.role !== 'assistant' || !msg.usage) return null;
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
  if (Number.isNaN(ts)) return null;
  return { ts, usage: msg.usage, model: typeof msg.model === 'string' ? msg.model : '' };
}

/**
 * Scan a profile's transcripts and aggregate token usage into the session and
 * weekly windows. Streams each file line-by-line; never throws (an unreadable
 * file is skipped). Returns zeroed totals when there's nothing on disk.
 */
export async function scanTranscriptUsage(
  configDir: string,
  opts: ScanOptions = {},
): Promise<TranscriptUsage> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const sessionMs = opts.sessionWindowMs ?? SESSION_WINDOW_MS;
  const weeklyMs = opts.weeklyWindowMs ?? WEEKLY_WINDOW_MS;
  const widestMs = Math.max(sessionMs, weeklyMs);
  const oldestMs = nowMs - widestMs;

  const result: TranscriptUsage = {
    session: emptyTotals(),
    weekly: emptyTotals(),
    filesScanned: 0,
  };

  const projectsDir = path.join(configDir, 'projects');
  const files = await candidateTranscripts(projectsDir, oldestMs);
  result.filesScanned = files.length;
  let lastActivity = 0;

  for (const file of files) {
    let rl: readline.Interface;
    try {
      rl = readline.createInterface({
        input: createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
    } catch {
      continue;
    }
    try {
      for await (const line of rl) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        const age = nowMs - parsed.ts;
        if (age < 0 || age > weeklyMs) continue; // outside the widest window
        if (parsed.ts > lastActivity) lastActivity = parsed.ts;
        addUsage(result.weekly, parsed.usage, parsed.model);
        if (age <= sessionMs) addUsage(result.session, parsed.usage, parsed.model);
      }
    } catch {
      // Partial read is fine — keep whatever we aggregated.
    } finally {
      rl.close();
    }
  }

  if (lastActivity > 0) result.lastActivityAt = new Date(lastActivity).toISOString();
  return result;
}

// ---------------------------------------------------------------------------
// Cost estimation (clearly an ESTIMATE — list prices, not billed amounts)
// ---------------------------------------------------------------------------

/** USD per million tokens, by component. List prices; override as needed. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Approximate public list prices (USD / 1M tokens). Keyed by a substring matched
 * against the model id. Only used for the "~est" cost column — token counts are
 * the authoritative figure. Update as Anthropic's pricing changes.
 */
export const MODEL_PRICING: Array<{ match: string; price: ModelPricing }> = [
  { match: 'opus', price: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: 'sonnet', price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { match: 'haiku', price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
];

/** Fallback when a model id matches no entry (defaults to Sonnet-class pricing). */
export const DEFAULT_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
};

export function pricingForModel(model: string): ModelPricing {
  const m = model.toLowerCase();
  for (const { match, price } of MODEL_PRICING) {
    if (m.includes(match)) return price;
  }
  return DEFAULT_PRICING;
}

/**
 * Estimate USD spend for a window's totals. This re-derives per-component cost
 * from the aggregate (using the window's dominant model mix is impossible from
 * the rolled-up totals, so we apportion by `byModel` share of total tokens).
 *
 * Returns a single estimated dollar figure. Best-effort — for display only.
 */
export function estimateCostUsd(totals: TokenTotals): number {
  if (totals.totalTokens === 0) return 0;
  // Split each token component proportionally across the models that ran, by
  // their share of total tokens. Good enough for an at-a-glance estimate.
  let cost = 0;
  const models = Object.keys(totals.byModel);
  const modelList = models.length > 0 ? models : [''];
  for (const model of modelList) {
    const share =
      models.length > 0 ? totals.byModel[model] / totals.totalTokens : 1;
    const p = pricingForModel(model);
    cost +=
      (totals.inputTokens * share * p.input +
        totals.outputTokens * share * p.output +
        totals.cacheCreationTokens * share * p.cacheWrite +
        totals.cacheReadTokens * share * p.cacheRead) /
      1_000_000;
  }
  return cost;
}
