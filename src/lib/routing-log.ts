import fs from 'fs-extra';
import path from 'path';
import { getClaudeProfilesDir } from './paths.js';
import type {
  RoutingEvent,
  RoutingEventKind,
  RoutingCategory,
} from '../types/index.js';

/**
 * Append-only routing history — the time-series of how work has been routed
 * across accounts (initial launches, deliberate switches, automatic failovers).
 *
 * Kept in its own file so it survives `chain reset` (which only clears
 * cooldowns) and so any process — the `run` supervisor, the channel sidecar in a
 * different session — can append to the same shared timeline. That shared,
 * durable file is what lets the history be *recalled across sessions*.
 */

const LOG_FILE = 'routing-log.json';
/** Hard cap so the log can't grow without bound; we keep the most recent. */
const MAX_EVENTS = 1000;

interface RoutingLogFile {
  events: RoutingEvent[];
}

function getLogPath(): string {
  return path.join(getClaudeProfilesDir(), LOG_FILE);
}

export async function loadRoutingLog(filter?: {
  chain?: string;
  kinds?: RoutingEventKind[];
}): Promise<RoutingEvent[]> {
  const p = getLogPath();
  let events: RoutingEvent[] = [];
  if (await fs.pathExists(p)) {
    try {
      const data = (await fs.readJson(p)) as RoutingLogFile;
      if (data && Array.isArray(data.events)) events = data.events;
    } catch {
      // Corrupt log is non-critical — treat as empty.
    }
  }
  if (filter?.chain) events = events.filter((e) => e.chain === filter.chain);
  if (filter?.kinds) events = events.filter((e) => filter.kinds!.includes(e.kind));
  return events;
}

async function saveRoutingLog(events: RoutingEvent[]): Promise<void> {
  const p = getLogPath();
  await fs.ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeJson(tmp, { events }, { spaces: 2 });
  await fs.rename(tmp, p);
}

/**
 * Serialize all appends from this process through a single promise chain. Each
 * append is read-modify-write, so concurrent fire-and-forget calls (e.g. a
 * `launch` and a `fallback` logged microseconds apart) would otherwise both load
 * the same snapshot and the later write would clobber the earlier event. The
 * chain guarantees in-order, lossless appends — and {@link flushRoutingLog} lets
 * a caller wait for them to land before `process.exit`.
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Append one routing event. Stamps `at` if the caller didn't, and trims the log
 * to the most recent {@link MAX_EVENTS}. Never throws — routing is advisory and
 * must not break a launch. Appends are serialized; the returned promise resolves
 * once this event has been persisted.
 */
export function appendRoutingEvent(
  event: Omit<RoutingEvent, 'at'> & { at?: string }
): Promise<void> {
  const run = writeChain.then(async () => {
    try {
      const events = await loadRoutingLog();
      const stamped: RoutingEvent = {
        ...event,
        at: event.at ?? new Date().toISOString(),
      };
      events.push(stamped);
      const trimmed =
        events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
      await saveRoutingLog(trimmed);
    } catch {
      // Swallow — the routing log is best-effort.
    }
  });
  // Keep the chain alive regardless of outcome so later appends still run.
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * Wait for every {@link appendRoutingEvent} issued so far to finish writing.
 * Call this before `process.exit` so fire-and-forget routing writes aren't cut
 * off mid-flight.
 */
export async function flushRoutingLog(): Promise<void> {
  await writeChain;
}

/** The N most recent events (chronological), optionally filtered by chain. */
export async function recentRouting(
  limit = 20,
  chain?: string
): Promise<RoutingEvent[]> {
  const events = await loadRoutingLog(chain ? { chain } : undefined);
  return events.slice(Math.max(0, events.length - limit));
}

export async function clearRoutingLog(): Promise<void> {
  await saveRoutingLog([]);
}

// ─── Pure: classification + labels (no IO, no color) ─────────────────────────

/** Group a kind into the two headline categories the user asked us to show. */
export function routingCategory(kind: RoutingEventKind): RoutingCategory {
  switch (kind) {
    case 'manual':
      return 'deliberate';
    case 'limit':
    case 'auth':
    case 'server':
    case 'policy':
      return 'auto-failover';
    case 'exhausted':
      return 'exhausted';
    case 'launch':
    default:
      return 'launch';
  }
}

export interface RoutingLabel {
  /** A width-1 glyph safe for terminal alignment. */
  glyph: string;
  /** Short human label, e.g. "manual switch" or "auto-failover (limit)". */
  text: string;
}

/**
 * The label/glyph for an event kind. Deliberate switches and automatic
 * failovers get visibly distinct markers so the two never read alike.
 */
export function routingLabel(kind: RoutingEventKind): RoutingLabel {
  switch (kind) {
    case 'manual':
      return { glyph: '◆', text: 'manual switch' };
    case 'limit':
      return { glyph: '▲', text: 'auto-failover (limit)' };
    case 'auth':
      return { glyph: '▲', text: 'auto-failover (auth)' };
    case 'server':
      return { glyph: '▲', text: 'auto-failover (server)' };
    case 'policy':
      return { glyph: '◇', text: 'auto-switch (policy)' };
    case 'exhausted':
      return { glyph: '×', text: 'exhausted' };
    case 'launch':
    default:
      return { glyph: '▸', text: 'launch' };
  }
}
