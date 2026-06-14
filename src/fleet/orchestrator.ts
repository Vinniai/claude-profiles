import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  claudeBin,
  dispatch,
  fleetStatus,
  resolveConfigDir,
  workerEnv,
  type WorkerResult,
} from '../lib/fleet.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';
import { loadHandoff, updateHandoff } from '../lib/handoff.js';

/**
 * Remote-control **orchestrator** — a single lead profile (e.g. `alice`) run as a
 * headless `claude -p` session that you drive over HTTP. The lead has the fleet
 * MCP server wired in via `--mcp-config`, so it can call `delegate` /
 * `delegate_parallel` / `fleet_status` to push work onto your OTHER accounts and
 * synthesize the results — all on subscription OAuth.
 *
 * One long-lived process: POST a prompt to `/control`, the lead answers (calling
 * its fleet tools as needed), and its session id is threaded back via `--resume`
 * so the conversation continues across calls. This is the "kick it off, then send
 * it prompts" loop — the lead is the orchestrator, the fleet are its hands.
 *
 *   claude-profiles fleet --remote-control --lead alice
 *   curl -s localhost:8798/control -d '{"prompt":"…"}'
 */

const ORCH_TOOLS = [
  'mcp__fleet__delegate',
  'mcp__fleet__delegate_parallel',
  'mcp__fleet__fleet_status',
];

function log(msg: string): void {
  process.stderr.write(`[claude-profiles fleet:orchestrator] ${msg}\n`);
}

/**
 * How the lead's `claude` child should re-launch THIS CLI as its stdio fleet MCP
 * server. Defaults to the globally-installed `claude-profiles`; override with
 * `CLAUDE_PROFILES_BIN` (e.g. `node /path/to/dist/index.js`) for dev installs.
 */
export function selfInvocation(): { command: string; args: string[] } {
  const override = process.env.CLAUDE_PROFILES_BIN;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }
  return { command: 'claude-profiles', args: [] };
}

/** The `--mcp-config` JSON that gives the lead its `fleet` tools (stdio server). */
export function mcpConfigJson(): string {
  const self = selfInvocation();
  return JSON.stringify({
    mcpServers: {
      fleet: { command: self.command, args: [...self.args, 'fleet', '--no-http'] },
    },
  });
}

/** The system prompt that tells the lead it is the fleet orchestrator. */
export function orchestratorSystemPrompt(lead: string): string {
  return [
    `You are the FLEET ORCHESTRATOR running on the "${lead}" account.`,
    'You coordinate work across other Claude accounts using the fleet MCP tools:',
    '- fleet_status(): see which accounts are healthy and their plans before dispatching.',
    '- delegate(profile, prompt, resume?): run one task on another account. The result',
    '  includes a sessionId — pass it back as `resume` to continue that worker with context.',
    '- delegate_parallel(tasks): fan independent tasks out across accounts at once.',
    'Prefer delegate_parallel when subtasks are independent. Delegate the heavy lifting to',
    'the other accounts; your job is to plan, dispatch, and synthesize their results into a',
    'single clear answer. Do not do work yourself that a worker could do in parallel.',
  ].join('\n');
}

/** Build the extra `claude` args that attach the fleet tools to the lead. */
export function orchestratorExtraArgs(lead: string, mcpConfigPath: string): string[] {
  return [
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--append-system-prompt', orchestratorSystemPrompt(lead),
    // Variadic — keep last so it doesn't swallow following flags.
    '--allowedTools', ...ORCH_TOOLS,
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// Coordinator — Claude Code's OFFICIAL Remote Control, steered from a device
// ──────────────────────────────────────────────────────────────────────────

/**
 * Launch the lead profile as a real Claude session with **Remote Control** on,
 * so you can steer it from claude.ai/code or the Claude mobile app — and with the
 * fleet MCP tools attached, so from your phone you can tell it to delegate work
 * to your other accounts. This is the intended "steer the coordinator from a
 * remote-controlled session on device" path.
 *
 * Two modes (both subscription OAuth — API-key vars are scrubbed):
 *  - interactive (default): `claude --remote-control <name>` + `--mcp-config` so
 *    the fleet tools and the orchestrator role are attached ephemerally. You can
 *    drive it locally in the terminal AND from a device.
 *  - server (`--server`): `claude remote-control` server mode — drive entirely
 *    from a device. It can't take `--mcp-config`, so the fleet MCP is registered
 *    into the lead's config first (idempotent).
 */
export interface CoordinatorOptions {
  lead: string;
  /** Session title shown at claude.ai/code. */
  name?: string;
  /** Use `claude remote-control` server mode instead of an interactive session. */
  server?: boolean;
  /** Permission mode for the session (e.g. acceptEdits, dontAsk). */
  permissionMode?: string;
  /**
   * Start a clean conversation instead of auto-resuming this coordinator's last
   * session. By default a relaunch of the same `--name` picks up where it left
   * off (see {@link stageCoordinatorResume}).
   */
  fresh?: boolean;
  /** Extra raw args forwarded to `claude`. */
  extraArgs?: string[];
  /** Injected spawn for tests. */
  spawnImpl?: typeof spawn;
}

/**
 * The chain/handoff key for a coordinator. Stable across relaunches of the same
 * `--name`, so a reconnect continues the same conversation thread. Falls back to
 * the lead profile when unnamed.
 */
export function coordinatorChain(opts: { name?: string; lead: string }): string {
  return opts.name ?? opts.lead;
}

/** Build the `claude` argv for the coordinator. Pure, for testing. */
export function coordinatorArgs(opts: CoordinatorOptions, mcpConfigPath: string): string[] {
  if (opts.server) {
    const a = ['remote-control'];
    if (opts.name) a.push('--name', opts.name);
    if (opts.permissionMode) a.push('--permission-mode', opts.permissionMode);
    return a.concat(opts.extraArgs ?? []);
  }
  const a = ['--remote-control'];
  if (opts.name) a.push(opts.name);
  a.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  a.push('--append-system-prompt', orchestratorSystemPrompt(opts.lead));
  if (opts.permissionMode) a.push('--permission-mode', opts.permissionMode);
  return a.concat(opts.extraArgs ?? []);
}

/**
 * Env for the coordinator's `claude` child. Starts from `workerEnv` (pins the
 * lead's config dir, scrubs API-key vars so it stays on subscription OAuth) and
 * then sets `CLAUDE_PROFILES_CHAIN` so our continuity/budget/notify/subagent
 * hooks recognise this as a chain-launched session and fire — without it they
 * no-op, and a coordinator you steer from your phone would silently skip the
 * budget guardrail and notification forwarding. The chain label is the session
 * name when given, else the lead profile name.
 */
export function coordinatorEnv(
  opts: CoordinatorOptions,
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = workerEnv(configDir, base);
  const chain = coordinatorChain(opts);
  env.CLAUDE_PROFILES_CHAIN = chain;
  env.CLAUDE_PROFILES_RUN = '1';
  // Stable, legible thread id so the handoff record keeps one identity across
  // relaunches of the same coordinator name (the Stop hook honours this over a
  // freshly-generated id), which is what lets a reconnect resume its own thread.
  env.CLAUDE_PROFILES_THREAD = `coord:${chain}`;
  return env;
}

/**
 * Stage a one-shot resume so a relaunched/reconnected coordinator picks up its
 * own last conversation. Server-mode Remote Control has no `--resume`/`--continue`
 * flag, so instead we set `pendingResume` on the chain's handoff record; the
 * SessionStart hook then injects the prior summary as context exactly once.
 *
 * No-ops (returns `willResume:false`) when `--fresh` is set or there is no prior
 * summary to restore — e.g. the very first launch of a name.
 */
export async function stageCoordinatorResume(
  opts: CoordinatorOptions,
): Promise<{ willResume: boolean; chain: string }> {
  const chain = coordinatorChain(opts);
  if (opts.fresh) return { willResume: false, chain };
  const record = await loadHandoff(chain);
  if (!record?.summary) return { willResume: false, chain };
  await updateHandoff(chain, { pendingResume: true });
  return { willResume: true, chain };
}

/**
 * Register the fleet MCP server into a profile's user-scope config (idempotent).
 * Needed for server mode, which can't take `--mcp-config`. Returns whether it was
 * newly added. Best-effort: an "already exists" error counts as success.
 */
export async function registerFleetMcp(configDir: string): Promise<{ added: boolean; message: string }> {
  const self = selfInvocation();
  const args = ['mcp', 'add', 'fleet', '--scope', 'user', '--', self.command, ...self.args, 'fleet', '--no-http'];
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), args, {
      env: workerEnv(configDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (out += d.toString()));
    child.on('error', (err) => resolve({ added: false, message: String(err) }));
    child.on('close', (code) => {
      const already = /already exists/i.test(out);
      resolve({ added: code === 0 && !already, message: out.trim() || (already ? 'already registered' : 'ok') });
    });
  });
}

/**
 * Launch the coordinator and resolve with its exit code. Inherits the terminal
 * (Remote Control prints a session URL + QR and stays up) and forwards signals.
 */
export async function launchCoordinator(opts: CoordinatorOptions): Promise<number> {
  const configDir = await resolveConfigDir(opts.lead);
  const doSpawn = opts.spawnImpl ?? spawn;

  let mcpConfigPath = '';
  let tmpDir = '';
  if (opts.server) {
    const reg = await registerFleetMcp(configDir);
    log(`fleet MCP ${reg.added ? 'registered' : 'present'} in ${opts.lead} config (${reg.message})`);
  } else {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-coord-'));
    mcpConfigPath = path.join(tmpDir, 'fleet-mcp.json');
    writeFileSync(mcpConfigPath, mcpConfigJson(), 'utf-8');
  }

  const resume = await stageCoordinatorResume(opts);
  if (resume.willResume) {
    log(`resuming the "${resume.chain}" coordinator's previous session — its context is restored on start (pass --fresh to start clean)`);
  } else if (opts.fresh) {
    log(`starting a fresh "${resume.chain}" coordinator conversation (--fresh)`);
  }

  const args = coordinatorArgs(opts, mcpConfigPath);
  log(`launching coordinator "${opts.lead}" — ${opts.server ? 'server' : 'interactive'} remote control`);
  log('open the printed claude.ai/code URL (or scan the QR) on your phone to steer it');

  return new Promise<number>((resolve, reject) => {
    const child = doSpawn(claudeBin(), args, {
      env: coordinatorEnv(opts, configDir),
      stdio: 'inherit',
    });
    const forward = (sig: NodeJS.Signals) => child.kill(sig);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const cleanup = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === 'ENOENT') {
        reject(
          new ClaudeProfilesError(
            `Could not find the "${claudeBin()}" CLI on your PATH`,
            ErrorCode.CLAUDE_NOT_FOUND,
            'Install Claude Code, or set CLAUDE_PROFILES_CLAUDE_BIN to its path.',
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      resolve(code ?? 0);
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP control face — headless, programmatic driving (NOT official remote ctrl)
// ──────────────────────────────────────────────────────────────────────────

export interface RemoteControlOptions {
  /** The lead profile that acts as the orchestrator. */
  lead: string;
  /** HTTP port for the control face (localhost only). */
  port?: number;
  /** An initial prompt to run at startup (the kickoff turn). */
  prompt?: string;
}

/**
 * The "how to steer me" readme printed when the orchestrator comes up — the
 * control surface a driver on the main thread uses. Pure so it can be tested
 * and reused.
 */
export function remoteControlReadme(lead: string, port: number): string {
  const base = `http://127.0.0.1:${port}`;
  return [
    '',
    '╭─ fleet http-control (headless) ───────────────────────────────────────',
    `│  lead (orchestrator): ${lead}`,
    `│  control face:        ${base}   (localhost only)`,
    '│',
    '│  STEER IT FROM THE MAIN THREAD:',
    '│',
    '│  • Send a prompt (the lead delegates to your other accounts, then answers):',
    `│      curl -s ${base}/control -d '{"prompt":"<what to do>"}'`,
    '│',
    '│  • Continue the same thread — just POST again; context is kept via --resume.',
    '│  • Start a fresh thread:',
    `│      curl -s ${base}/control -d '{"prompt":"…","reset":true}'`,
    `│      curl -s -XPOST ${base}/reset`,
    '│',
    '│  • Health of the lead + every account it can delegate to:',
    `│      curl -s ${base}/status`,
    '│',
    '│  The lead has fleet tools: delegate, delegate_parallel, fleet_status.',
    '│  Stop with Ctrl-C.',
    '╰───────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}

export interface RemoteControlHandle {
  close: () => Promise<void>;
  /** The mcp-config file path (exposed for tests / debugging). */
  mcpConfigPath: string;
}

/**
 * Start the remote-control HTTP face. Maintains the lead's orchestrator session
 * id in memory and threads it through `--resume` so each `/control` POST
 * continues the same conversation. `{ "reset": true }` starts a fresh thread.
 */
export async function startRemoteControl(
  opts: RemoteControlOptions,
): Promise<RemoteControlHandle> {
  const { lead, port = 8798 } = opts;

  // Validate the lead exists before we advertise a control face for it.
  await resolveConfigDir(lead);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-fleet-'));
  const mcpConfigPath = path.join(tmpDir, 'fleet-mcp.json');
  writeFileSync(mcpConfigPath, mcpConfigJson(), 'utf-8');

  let sessionId: string | undefined;
  const extraArgs = orchestratorExtraArgs(lead, mcpConfigPath);

  // Serialize control turns through a single-slot promise chain so the
  // read(sessionId) → dispatch → write(sessionId) cycle is atomic. Without this,
  // overlapping /control POSTs read the same pre-dispatch sessionId and the
  // later-resolving write clobbers the earlier — forking session continuity.
  let chain: Promise<unknown> = Promise.resolve();

  function control(prompt: string, reset: boolean): Promise<WorkerResult> {
    const next = chain.then(async () => {
      if (reset) sessionId = undefined;
      const result = await dispatch({
        profile: lead,
        prompt,
        resume: sessionId,
        extraArgs,
      });
      if (result.sessionId) sessionId = result.sessionId;
      return result;
    });
    // Keep the chain alive after a rejection without leaking it as unhandled; the
    // caller still receives the real rejection via the returned `next`.
    chain = next.catch(() => {});
    return next;
  }

  // Reset goes through the same chain so it can't clear sessionId mid-flight of a
  // queued control turn — it lands in order, after any already-enqueued dispatch.
  function resetSession(): Promise<void> {
    const next = chain.then(() => {
      sessionId = undefined;
    });
    chain = next.catch(() => {});
    return next;
  }

  const server = http.createServer((req, res) => {
    // handle() is async and can reject before writing a reply (fleetStatus, body
    // read, dispatch). Without this catch the socket would hang with no response.
    handle(req, res).catch((err) => {
      log(`control handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        // A partial response is already on the wire — abort rather than double-send.
        res.destroy();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
    };

    if (method === 'GET' && url.pathname === '/status') {
      reply(200, { lead, orchestratorSession: sessionId ?? null, fleet: await fleetStatus() });
      return;
    }

    if (method === 'POST' && url.pathname === '/reset') {
      await resetSession();
      reply(200, { ok: true, orchestratorSession: null });
      return;
    }

    if (method === 'POST' && url.pathname === '/control') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: Record<string, unknown> = {};
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        if (raw) body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        reply(400, { error: 'body must be JSON {prompt, reset?}' });
        return;
      }
      const prompt = typeof body.prompt === 'string' ? body.prompt : null;
      if (!prompt) {
        reply(400, { error: 'control requires a `prompt` string' });
        return;
      }
      const result = await control(prompt, body.reset === true);
      reply(result.ok ? 200 : 502, {
        ok: result.ok,
        lead,
        text: result.text,
        orchestratorSession: result.sessionId ?? sessionId ?? null,
        costUsd: result.costUsd,
        numTurns: result.numTurns,
        ...(result.ok ? {} : { reason: result.outcome.reason, error: result.error }),
      });
      return;
    }

    reply(404, { error: 'not found', paths: ['/control (POST)', '/status (GET)', '/reset (POST)'] });
  }

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      // The readme is the steer-from-the-main-thread control surface.
      process.stderr.write(remoteControlReadme(lead, port) + '\n');
      log(`fleet tools attached via ${mcpConfigPath}`);
      resolve();
    });
  });

  // Optional kickoff turn — run an initial prompt and surface its result.
  if (opts.prompt) {
    log(`kickoff prompt → "${opts.prompt}"`);
    const result = await control(opts.prompt, false);
    log(`kickoff ${result.ok ? 'ok' : `failed: ${result.outcome.reason}`} (session ${sessionId ?? 'n/a'})`);
    process.stderr.write(`\n── kickoff result ──\n${result.text || '(no text)'}\n────────────────────\n\n`);
  }

  return {
    mcpConfigPath,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    },
  };
}
