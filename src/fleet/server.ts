import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  dispatch,
  runFleet,
  fleetStatus,
  type WorkerTask,
  type WorkerResult,
} from '../lib/fleet.js';

/**
 * claude-profiles **fleet** — an MCP server that lets ONE orchestrator session
 * delegate work to your OTHER profiles and collect structured results. Each
 * delegated task runs as a headless `claude -p` worker pinned to that profile's
 * subscription OAuth (no API billing). The orchestrator is just a normal Claude
 * session that has this server's tools.
 *
 * Tools exposed to the orchestrator:
 *   - delegate(profile, prompt, …)        → run one worker, return its result
 *   - delegate_parallel(tasks[])          → fan out across profiles concurrently
 *   - fleet_status()                      → health + last-used per profile
 *
 * A localhost HTTP face mirrors these (POST /delegate, POST /delegate-parallel,
 * GET /status) so a remote driver can dispatch without an MCP session.
 *
 * IMPORTANT: stdout is the MCP JSON-RPC transport. All logging goes to stderr.
 */

const SERVER_NAME = 'claude-profiles-fleet';
const DEFAULT_CONCURRENCY = 4;

function log(msg: string): void {
  process.stderr.write(`[claude-profiles fleet] ${msg}\n`);
}

// ─── Pure: shape a worker result for return ──────────────────────────────────

/** Trim a worker result to the fields a caller acts on (drops bulky raw text). */
export function summarizeResult(r: WorkerResult): Record<string, unknown> {
  return {
    profile: r.profile,
    ok: r.ok,
    kind: r.kind,
    text: r.text,
    sessionId: r.sessionId,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    numTurns: r.numTurns,
    ...(r.ok ? {} : { reason: r.outcome.reason }),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Parse a loose tool-args object into a typed {@link WorkerTask}. */
export function taskFromArgs(args: Record<string, unknown>): WorkerTask | null {
  const profile = typeof args.profile === 'string' ? args.profile : null;
  const prompt = typeof args.prompt === 'string' ? args.prompt : null;
  if (!profile || !prompt) return null;
  return {
    profile,
    prompt,
    model: typeof args.model === 'string' ? args.model : undefined,
    resume: typeof args.resume === 'string' ? args.resume : undefined,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
  };
}

// ─── Server wiring ───────────────────────────────────────────────────────────

export interface StartFleetOptions {
  /** TCP port for the localhost HTTP face (0 disables it). */
  port?: number;
  /** Connect the MCP stdio transport (false for HTTP-only test mode). */
  stdio?: boolean;
  /** Default max concurrent workers for delegate_parallel. */
  concurrency?: number;
}

export interface FleetHandle {
  close: () => Promise<void>;
}

export async function startFleetServer(
  opts: StartFleetOptions = {},
): Promise<FleetHandle> {
  const { port = 8798, stdio = true, concurrency = DEFAULT_CONCURRENCY } = opts;

  const mcp = new Server(
    { name: SERVER_NAME, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'These tools delegate work to OTHER claude-profiles accounts as headless workers. ' +
        'Use delegate(profile, prompt) to run a single task on another account, or ' +
        'delegate_parallel(tasks) to fan several out at once. Each result includes a sessionId — ' +
        'pass it back as `resume` to continue that worker with its context intact. ' +
        'Call fleet_status() to see which accounts are healthy before dispatching.',
    },
  );

  // ── tools ──
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'delegate',
        description:
          'Run a prompt as a headless worker on another profile (its own account). Returns the worker’s text, sessionId (pass back as resume to continue), and cost.',
        inputSchema: {
          type: 'object',
          required: ['profile', 'prompt'],
          properties: {
            profile: { type: 'string', description: 'Profile/account name to run under.' },
            prompt: { type: 'string', description: 'The prompt to send to the worker.' },
            model: { type: 'string', description: 'Optional model override.' },
            resume: { type: 'string', description: 'Session id from a prior result to continue that worker.' },
            timeoutMs: { type: 'number', description: 'Kill the worker after this many ms.' },
          },
        },
      },
      {
        name: 'delegate_parallel',
        description:
          'Fan several tasks out across profiles concurrently. Each task is {profile, prompt, model?, resume?}. Returns one result per task, in order.',
        inputSchema: {
          type: 'object',
          required: ['tasks'],
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                required: ['profile', 'prompt'],
                properties: {
                  profile: { type: 'string' },
                  prompt: { type: 'string' },
                  model: { type: 'string' },
                  resume: { type: 'string' },
                  timeoutMs: { type: 'number' },
                },
              },
            },
            concurrency: { type: 'number', description: `Max workers at once (default ${concurrency}).` },
          },
        },
      },
      {
        name: 'fleet_status',
        description: 'Report each profile’s health, plan, last-used time, and cached usage.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'delegate') {
      const task = taskFromArgs(args);
      if (!task) throw new Error('delegate requires `profile` and `prompt`');
      const result = await dispatch(task);
      return { content: [{ type: 'text', text: JSON.stringify(summarizeResult(result), null, 2) }] };
    }

    if (name === 'delegate_parallel') {
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      const tasks: WorkerTask[] = [];
      for (const t of rawTasks) {
        const task = taskFromArgs((t ?? {}) as Record<string, unknown>);
        if (task) tasks.push(task);
      }
      if (tasks.length === 0) throw new Error('delegate_parallel requires a non-empty `tasks` array');
      const results = await runFleet(tasks, {
        concurrency: typeof args.concurrency === 'number' ? args.concurrency : concurrency,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(results.map(summarizeResult), null, 2) }],
      };
    }

    if (name === 'fleet_status') {
      const snap = await fleetStatus();
      return { content: [{ type: 'text', text: JSON.stringify(snap, null, 2) }] };
    }

    throw new Error(`unknown tool: ${name}`);
  });

  let connected = false;
  if (stdio) {
    await mcp.connect(new StdioServerTransport());
    connected = true;
    log('fleet attached — delegate / delegate_parallel / fleet_status available');
  }

  // ── HTTP control face (localhost only) ──
  let httpServer: http.Server | undefined;
  if (port > 0) {
    httpServer = http.createServer((reqHttp, res) => {
      void handleHttp(reqHttp, res, concurrency);
    });
    await new Promise<void>((resolve) => {
      httpServer!.listen(port, '127.0.0.1', () => {
        log(`HTTP face on http://127.0.0.1:${port} (POST /delegate, /delegate-parallel; GET /status)`);
        resolve();
      });
    });
  }

  return {
    close: async () => {
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
  defaultConcurrency: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/status') {
    send(res, 200, await fleetStatus());
    return;
  }

  if (method === 'POST' && url.pathname === '/delegate') {
    const body = await readJsonBody(req);
    const task = taskFromArgs(body);
    if (!task) {
      send(res, 400, { error: 'delegate requires `profile` and `prompt`' });
      return;
    }
    send(res, 200, summarizeResult(await dispatch(task)));
    return;
  }

  if (method === 'POST' && url.pathname === '/delegate-parallel') {
    const body = await readJsonBody(req);
    const rawTasks = Array.isArray(body.tasks) ? body.tasks : [];
    const tasks: WorkerTask[] = [];
    for (const t of rawTasks) {
      const task = taskFromArgs((t ?? {}) as Record<string, unknown>);
      if (task) tasks.push(task);
    }
    if (tasks.length === 0) {
      send(res, 400, { error: 'delegate-parallel requires a non-empty `tasks` array' });
      return;
    }
    const results = await runFleet(tasks, {
      concurrency: typeof body.concurrency === 'number' ? body.concurrency : defaultConcurrency,
    });
    send(res, 200, results.map(summarizeResult));
    return;
  }

  send(res, 404, { error: 'not found', paths: ['/status', '/delegate', '/delegate-parallel'] });
}
