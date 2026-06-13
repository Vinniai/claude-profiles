import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadProfiles } from '../lib/profiles.js';
import {
  loadState,
  setProfileCooldown,
  isHealthy,
  cooldownRemainingMs,
} from '../lib/state.js';
import { profileNameForConfigDir, updateHandoff } from '../lib/handoff.js';
import type {
  ProfileConfig,
  ProfileRuntimeState,
  RuntimeStateFile,
} from '../types/index.js';

/**
 * claude-profiles **channel** — a Claude Code channel (an MCP server that pushes
 * events into a running session). It does two jobs:
 *
 *   1. Watches `state.json` and pushes a `<channel>` event whenever an account on
 *      the active chain changes health (hits a limit, needs auth, recovers).
 *   2. Exposes a `switch_account` tool / HTTP endpoint so you can deliberately
 *      move work to another account **mid-run**. It does this by writing a
 *      cooldown on the current account (and, for an explicit target, on every
 *      healthy account ahead of it in the chain). When the interactive `run`
 *      supervisor sees the active profile cooled-down on exit, it relaunches on
 *      the next account and the continuity hooks restore context.
 *
 * The channel cannot itself swap the running OAuth account — that boundary
 * belongs to the launcher — so it is the *signal + steering* surface, and the
 * launcher is the executor.
 *
 * IMPORTANT: stdout is the MCP transport. Everything here logs to stderr only.
 */

const SERVER_NAME = 'claude-profiles';
const DEFAULT_SWITCH_COOLDOWN_MIN = 60;
const DEFAULT_POLL_MS = 1500;

function log(msg: string): void {
  // stderr — never stdout (that is the JSON-RPC channel).
  process.stderr.write(`[claude-profiles channel] ${msg}\n`);
}

// ─── Pure: current session context from the inherited environment ────────────

export interface ChannelContext {
  /** Resolved profile name this session is running under (or null). */
  profile: string | null;
  /** Active chain name, set by the interactive supervisor. */
  chain: string | null;
  /** Continuity thread id, if any. */
  threadId: string | null;
  configDir: string | null;
}

/**
 * Work out which profile/chain this channel is attached to from the environment
 * the launcher exported into the `claude` child (which spawns this MCP server).
 */
export function resolveCurrentContext(
  env: NodeJS.ProcessEnv,
  config: ProfileConfig
): ChannelContext {
  const configDir = env.CLAUDE_CONFIG_DIR ?? null;
  const profile = profileNameForConfigDir(config.profiles, configDir ?? undefined) ?? null;
  return {
    profile,
    chain: env.CLAUDE_PROFILES_CHAIN ?? null,
    threadId: env.CLAUDE_PROFILES_THREAD ?? null,
    configDir,
  };
}

// ─── Pure: state diffing → channel events ────────────────────────────────────

export interface ChannelEvent {
  content: string;
  /** Tag attributes. Keys MUST be identifiers (letters/digits/underscore). */
  meta: Record<string, string>;
}

function remainingLabel(s: ProfileRuntimeState | undefined, now: Date): string {
  const ms = cooldownRemainingMs(s, now);
  if (ms == null) return '';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin <= 0) return 'shortly';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return [h > 0 ? `${h}h` : '', m > 0 || h === 0 ? `${m}m` : ''].join('');
}

/**
 * Compare one profile's previous vs next runtime state and, if its health
 * meaningfully changed, return the channel event describing it. Returns null for
 * no-op changes (e.g. usage figures updating while health is unchanged).
 */
export function formatStateEvent(
  profile: string,
  prev: ProfileRuntimeState | undefined,
  next: ProfileRuntimeState | undefined,
  now: Date = new Date()
): ChannelEvent | null {
  const wasHealthy = isHealthy(prev, now);
  const nowHealthy = isHealthy(next, now);

  // needs-auth is its own, more urgent signal.
  if (!prev?.needsAuth && next?.needsAuth) {
    return {
      content: `Account "${profile}" needs re-authentication (${next.lastError ?? 'login expired'}). Run \`claude-profiles profile login ${profile}\`, or switch to another account.`,
      meta: { event: 'needs_auth', profile },
    };
  }

  if (wasHealthy && !nowHealthy) {
    const resets = remainingLabel(next, now);
    const resetPart = resets ? ` resets in ${resets}.` : '';
    return {
      content: `Account "${profile}" hit a usage limit and is cooling down.${resetPart} Finish up and exit when ready — the supervisor will resume this conversation on the next account in the chain.`,
      meta: {
        event: 'limit',
        profile,
        ...(resets ? { resets_in: resets } : {}),
      },
    };
  }

  if (!wasHealthy && nowHealthy) {
    return {
      content: `Account "${profile}" has recovered and is available again.`,
      meta: { event: 'recovered', profile },
    };
  }

  return null;
}

/** Diff two whole state files into the set of health-transition events. */
export function diffStates(
  prev: RuntimeStateFile,
  next: RuntimeStateFile,
  now: Date = new Date()
): ChannelEvent[] {
  const names = new Set([
    ...Object.keys(prev.profiles),
    ...Object.keys(next.profiles),
  ]);
  const events: ChannelEvent[] = [];
  for (const name of names) {
    const e = formatStateEvent(name, prev.profiles[name], next.profiles[name], now);
    if (e) events.push(e);
  }
  return events;
}

// ─── Pure: planning a deliberate switch ──────────────────────────────────────

export interface SwitchPlan {
  /** Profiles to cool down so the supervisor lands on `next`. */
  cooldown: string[];
  /** The account the supervisor is expected to resume on (best-effort). */
  next: string | null;
  /** Human-readable explanation of what the plan does. */
  note: string;
}

/**
 * Decide which profiles to cool down to move work off `current`.
 *
 * - No target → cool only `current`; the supervisor picks the next healthy
 *   profile after it in chain order.
 * - Target ahead of `current` in the chain → cool `current` plus every profile
 *   between them so the supervisor skips straight to the target.
 * - Target missing/behind/equal → cool only `current` (best we can do) and note it.
 */
export function planSwitch(opts: {
  chainNames: string[];
  current: string | null;
  target?: string;
  state: RuntimeStateFile;
  now?: Date;
}): SwitchPlan {
  const { chainNames, current, target, state, now = new Date() } = opts;

  if (!current) {
    return { cooldown: [], next: null, note: 'No current profile resolved — nothing to switch.' };
  }

  const curIdx = chainNames.indexOf(current);

  // No chain context (single-profile run, or current not part of the chain):
  // we can still cool the current account, but cannot predict a successor.
  if (curIdx === -1) {
    return {
      cooldown: [current],
      next: null,
      note: `Cooled "${current}". No chain context, so the supervisor has no successor to resume on.`,
    };
  }

  const firstHealthyAfter = (from: number): string | null => {
    for (let i = from + 1; i < chainNames.length; i++) {
      if (isHealthy(state.profiles[chainNames[i]], now)) return chainNames[i];
    }
    return null;
  };

  if (target) {
    const tIdx = chainNames.indexOf(target);
    if (tIdx > curIdx) {
      const cooldown = chainNames.slice(curIdx, tIdx); // current … one before target
      return {
        cooldown,
        next: target,
        note: `Cooling ${cooldown.map((n) => `"${n}"`).join(', ')} so the supervisor resumes on "${target}".`,
      };
    }
    // Target not ahead of current — fall back to cooling current only.
    const next = firstHealthyAfter(curIdx);
    return {
      cooldown: [current],
      next,
      note:
        tIdx === -1
          ? `"${target}" is not in chain "${chainNames.join(' → ')}". Cooled "${current}"; supervisor resumes on ${next ? `"${next}"` : 'the next healthy account'}.`
          : `"${target}" is not ahead of "${current}" in the chain. Cooled "${current}"; supervisor resumes on ${next ? `"${next}"` : 'the next healthy account'}.`,
    };
  }

  const next = firstHealthyAfter(curIdx);
  return {
    cooldown: [current],
    next,
    note: `Cooled "${current}"; supervisor resumes on ${next ? `"${next}"` : 'the next healthy account'} when this session exits.`,
  };
}

// ─── Impure: apply a switch / simulate a limit ───────────────────────────────

function chainNamesFor(config: ProfileConfig, chain: string | null): string[] {
  if (!chain) return [];
  return (config.chains?.[chain] ?? []).filter((n) => config.profiles[n]);
}

export interface SwitchResult extends SwitchPlan {
  applied: boolean;
}

/**
 * Deliberately move work off the current account. Writes the cooldowns from
 * {@link planSwitch}; the interactive supervisor relaunches on `next` when the
 * session exits, restoring context via the continuity hooks.
 */
export async function requestSwitch(opts: {
  target?: string;
  reason?: string;
  minutes?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<SwitchResult> {
  const { target, env = process.env, now = new Date() } = opts;
  const reason = opts.reason ?? 'manual switch via channel';
  const minutes = opts.minutes ?? DEFAULT_SWITCH_COOLDOWN_MIN;

  const config = await loadProfiles();
  const ctx = resolveCurrentContext(env, config);
  const state = await loadState();

  const plan = planSwitch({
    chainNames: chainNamesFor(config, ctx.chain),
    current: ctx.profile,
    target,
    state,
    now,
  });

  const until = new Date(now.getTime() + minutes * 60_000);
  for (const name of plan.cooldown) {
    await setProfileCooldown(name, until, reason, now);
  }

  // Leave a breadcrumb on the chain's handoff record for visibility.
  if (ctx.chain && plan.cooldown.length > 0) {
    try {
      await updateHandoff(ctx.chain, { pendingFailover: true, failoverKind: 'manual' }, now);
    } catch {
      // Best-effort only.
    }
  }

  return { ...plan, applied: plan.cooldown.length > 0 };
}

/**
 * Simulate an account hitting a usage limit, for testing the failover path
 * without burning a real account. Cools the named profile (default: current);
 * the state watcher turns that into a `<channel>` "limit" event.
 */
export async function simulateLimit(opts: {
  profile?: string;
  minutes?: number;
  reason?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<{ profile: string | null; until: string | null }> {
  const { env = process.env, now = new Date() } = opts;
  const minutes = opts.minutes ?? DEFAULT_SWITCH_COOLDOWN_MIN;
  const reason = opts.reason ?? 'simulated usage limit (channel test)';

  const config = await loadProfiles();
  const ctx = resolveCurrentContext(env, config);
  const profile = opts.profile ?? ctx.profile;
  if (!profile) return { profile: null, until: null };

  const until = new Date(now.getTime() + minutes * 60_000);
  await setProfileCooldown(profile, until, reason, now);
  return { profile, until: until.toISOString() };
}

// ─── Impure: status snapshot ─────────────────────────────────────────────────

export async function statusSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): Promise<{
  current: string | null;
  chain: string | null;
  profiles: Array<{ name: string; healthy: boolean; resetsIn: string | null }>;
}> {
  const config = await loadProfiles();
  const ctx = resolveCurrentContext(env, config);
  const state = await loadState();
  const names = ctx.chain
    ? chainNamesFor(config, ctx.chain)
    : Object.keys(config.profiles);
  return {
    current: ctx.profile,
    chain: ctx.chain,
    profiles: names.map((name) => {
      const s = state.profiles[name];
      const label = remainingLabel(s, now);
      return {
        name,
        healthy: isHealthy(s, now),
        resetsIn: isHealthy(s, now) ? null : label || 'soon',
      };
    }),
  };
}

// ─── Server wiring ───────────────────────────────────────────────────────────

export interface StartChannelOptions {
  /** TCP port for the localhost HTTP control face (0 disables it). */
  port?: number;
  /** Connect the MCP stdio transport (false for HTTP-only test mode). */
  stdio?: boolean;
  /** State-file poll interval in ms. */
  pollMs?: number;
}

export interface ChannelHandle {
  close: () => Promise<void>;
}

export async function startChannelServer(
  opts: StartChannelOptions = {}
): Promise<ChannelHandle> {
  const { port = 8799, stdio = true, pollMs = DEFAULT_POLL_MS } = opts;

  const config = await loadProfiles().catch(() => ({ profiles: {} }) as ProfileConfig);
  const ctx = resolveCurrentContext(process.env, config);

  const mcp = new Server(
    { name: SERVER_NAME, version: '1.0.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        'Events from the claude-profiles channel arrive as <channel source="claude-profiles" event="...">. ' +
        'event="limit" means the current account hit a usage limit and is cooling down; "needs_auth" means it must re-login; ' +
        '"recovered" means an account is healthy again. When you see a "limit"/"needs_auth" event, tell the user the active ' +
        'account is throttled and that exiting will resume the conversation on the next account in the chain. ' +
        'To deliberately move work to another account, call the switch_account tool (optionally with a target profile name) — ' +
        'only do this when the user explicitly asks to switch accounts.',
    }
  );

  let connected = false;
  const sseListeners = new Set<http.ServerResponse>();

  function emit(event: ChannelEvent): void {
    // Mirror to any /events SSE watchers (so curl -N can see it without a session).
    const payload = JSON.stringify({ source: SERVER_NAME, ...event.meta, content: event.content });
    for (const res of sseListeners) res.write(`data: ${payload}\n\n`);
    // Push into the live Claude session, if the MCP transport is connected.
    if (connected) {
      mcp
        .notification({
          method: 'notifications/claude/channel',
          params: { content: event.content, meta: event.meta },
        })
        .catch((e: unknown) => log(`notify failed: ${String(e)}`));
    }
  }

  // ── tools ──
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'switch_account',
        description:
          'Deliberately move work off the current account. Cools the current account (and any healthy accounts ahead of an explicit target in the chain) so the run supervisor resumes the conversation on the next/target account when this session exits.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Profile name to resume on (must be ahead in the chain). Omit to use the next account.' },
            reason: { type: 'string', description: 'Why you are switching (recorded as the cooldown reason).' },
            minutes: { type: 'number', description: `How long to cool the account down (default ${DEFAULT_SWITCH_COOLDOWN_MIN}).` },
          },
        },
      },
      {
        name: 'channel_status',
        description: 'Report the current account, active chain, and each account’s health.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (name === 'switch_account') {
      const result = await requestSwitch({
        target: typeof args.target === 'string' ? args.target : undefined,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
      });
      return { content: [{ type: 'text', text: result.note }] };
    }
    if (name === 'channel_status') {
      const snap = await statusSnapshot();
      return { content: [{ type: 'text', text: JSON.stringify(snap, null, 2) }] };
    }
    throw new Error(`unknown tool: ${name}`);
  });

  if (stdio) {
    await mcp.connect(new StdioServerTransport());
    connected = true;
    log(`channel attached — profile=${ctx.profile ?? '?'} chain=${ctx.chain ?? '(none)'}`);
  }

  // ── state watcher (poll; state.json is rewritten via atomic rename) ──
  let lastState: RuntimeStateFile = await loadState().catch(() => ({ profiles: {} }));
  const timer = setInterval(() => {
    void (async () => {
      try {
        const next = await loadState();
        const events = diffStates(lastState, next);
        lastState = next;
        for (const e of events) emit(e);
      } catch (e) {
        log(`watch error: ${String(e)}`);
      }
    })();
  }, pollMs);
  timer.unref?.();

  // ── HTTP control face (localhost only) ──
  let httpServer: http.Server | undefined;
  if (port > 0) {
    httpServer = http.createServer((reqHttp, res) => {
      void handleHttp(reqHttp, res, sseListeners, emit);
    });
    await new Promise<void>((resolve) => {
      httpServer!.listen(port, '127.0.0.1', () => {
        log(`HTTP control face on http://127.0.0.1:${port} (POST /switch, /simulate-limit; GET /status, /events)`);
        resolve();
      });
    });
  }

  return {
    close: async () => {
      clearInterval(timer);
      for (const res of sseListeners) res.end();
      sseListeners.clear();
      if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
      if (connected) await mcp.close().catch(() => {});
    },
  };
}

// ─── HTTP request handling ───────────────────────────────────────────────────

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sseListeners: Set<http.ServerResponse>,
  emit: (e: ChannelEvent) => void
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseListeners.add(res);
    req.on('close', () => sseListeners.delete(res));
    return;
  }

  if (method === 'GET' && url.pathname === '/status') {
    send(res, 200, await statusSnapshot());
    return;
  }

  if (method === 'POST' && url.pathname === '/switch') {
    const body = await readJsonBody(req);
    const result = await requestSwitch({
      target: typeof body.target === 'string' ? body.target : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      minutes: typeof body.minutes === 'number' ? body.minutes : undefined,
    });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/simulate-limit') {
    const body = await readJsonBody(req);
    const result = await simulateLimit({
      profile: typeof body.profile === 'string' ? body.profile : undefined,
      minutes: typeof body.minutes === 'number' ? body.minutes : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    // Surface immediately too (don't wait for the poll) if a profile was cooled.
    if (result.profile) {
      emit({
        content: `Simulated a usage limit on "${result.profile}".`,
        meta: { event: 'simulated', profile: result.profile },
      });
    }
    send(res, 200, result);
    return;
  }

  send(res, 404, { error: 'not found', paths: ['/status', '/switch', '/simulate-limit', '/events'] });
}
