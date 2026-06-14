import { Command } from 'commander';
import { startFleetServer } from '../fleet/server.js';
import { startRemoteControl, launchCoordinator } from '../fleet/orchestrator.js';
import { dispatch, runFleet, fleetStatus, type WorkerTask } from '../lib/fleet.js';
import { logger } from '../utils/logger.js';

/**
 * `claude-profiles fleet` — run the fleet MCP server, or dispatch a task
 * directly from the CLI for testing.
 *
 * The server (default action) is meant to be wired into your orchestrator
 * session as an MCP server, e.g.:
 *
 *   claude mcp add fleet -- claude-profiles fleet --no-http
 *
 * Then, inside that session, the orchestrator gets `delegate`,
 * `delegate_parallel`, and `fleet_status` tools that run work on your other
 * accounts as headless subscription-OAuth workers.
 */

interface ServerOptions {
  port: string;
  stdio: boolean;
  http: boolean;
  concurrency: string;
}

export const fleetCommand = new Command('fleet')
  .description(
    'Run the fleet MCP server so one orchestrator session can delegate work to your other accounts (headless subscription-OAuth workers)',
  )
  .option('-p, --port <port>', 'Localhost HTTP face port (0 to disable)', '8798')
  .option('--no-stdio', 'Skip the MCP stdio transport (HTTP-only test mode)')
  .option('--no-http', 'Disable the HTTP face (MCP stdio only)')
  .option('-c, --concurrency <n>', 'Default max concurrent workers', '4')
  .action(async (options: ServerOptions) => {
    const handle = await startFleetServer({
      port: options.http ? Number(options.port) : 0,
      stdio: options.stdio,
      concurrency: Number(options.concurrency),
    });
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    await new Promise<void>(() => {});
  });

// `fleet http-control` — HEADLESS orchestrator driven over localhost HTTP. For
// steering from a phone/browser use `fleet coordinator` (official Remote Control).
fleetCommand
  .command('http-control')
  .description('Run a lead profile as a headless orchestrator you drive over localhost HTTP (POST /control)')
  .requiredOption('--lead <profile>', 'The orchestrator (lead) profile, e.g. alice')
  .option('-p, --port <port>', 'Localhost HTTP port', '8798')
  .option('--prompt <prompt>', 'An initial kickoff prompt to run at startup')
  .action(async (opts: { lead: string; port: string; prompt?: string }) => {
    const handle = await startRemoteControl({
      lead: opts.lead,
      port: Number(opts.port),
      prompt: opts.prompt,
    });
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    await new Promise<void>(() => {});
  });

// `fleet coordinator` — launch a lead profile as an OFFICIAL Remote Control
// session (claude.ai/code or the mobile app) with the fleet tools attached, so
// you can steer it — and have it delegate to your other accounts — from a device.
fleetCommand
  .command('coordinator')
  .description(
    'Launch a lead profile as a Remote Control session (steer from claude.ai/code or the Claude app) with the fleet tools attached',
  )
  .requiredOption('--lead <profile>', 'The coordinator (lead) profile, e.g. alice')
  .option('-n, --name <name>', 'Session title shown at claude.ai/code')
  .option('--server', 'Use `claude remote-control` server mode (drive entirely from a device)')
  .option('--permission-mode <mode>', 'Permission mode (acceptEdits, dontAsk, bypassPermissions, …)')
  .action(
    async (opts: { lead: string; name?: string; server?: boolean; permissionMode?: string }) => {
      const code = await launchCoordinator({
        lead: opts.lead,
        name: opts.name ?? `Fleet coordinator (${opts.lead})`,
        server: opts.server,
        permissionMode: opts.permissionMode,
      });
      process.exit(code);
    },
  );

// `fleet run <profile> <prompt>` — one-shot dispatch from the CLI (for testing).
fleetCommand
  .command('run <profile> <prompt>')
  .description('Dispatch a single prompt to one profile and print its result')
  .option('-m, --model <model>', 'Model override')
  .option('-r, --resume <sessionId>', 'Resume a prior worker session')
  .option('--json', 'Print the full result object as JSON')
  .action(
    async (
      profile: string,
      prompt: string,
      opts: { model?: string; resume?: string; json?: boolean },
    ) => {
      const task: WorkerTask = { profile, prompt, model: opts.model, resume: opts.resume };
      const result = await dispatch(task);
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      if (result.ok) {
        process.stdout.write(result.text + '\n');
        if (result.sessionId) logger.dim(`session: ${result.sessionId}`);
        if (result.costUsd != null) logger.dim(`cost: $${result.costUsd.toFixed(4)}`);
      } else {
        logger.error(`${profile}: ${result.outcome.reason}${result.error ? ` — ${result.error}` : ''}`);
        process.exitCode = 1;
      }
    },
  );

// `fleet status` — print health for every profile.
fleetCommand
  .command('status')
  .description('Show each profile’s health, plan, and last-used time')
  .option('--json', 'Print as JSON')
  .action(async (opts: { json?: boolean }) => {
    const rows = await fleetStatus();
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    for (const r of rows) {
      const health = r.needsAuth ? 'needs-login' : r.healthy ? 'healthy' : 'cooling';
      logger.info(`${r.name}${r.plan ? ` (${r.plan})` : ''} — ${health}`);
    }
  });

// `fleet parallel` — dispatch a JSON array of tasks (for testing).
fleetCommand
  .command('parallel <tasksJson>')
  .description('Dispatch a JSON array of {profile,prompt,model?,resume?} tasks concurrently')
  .option('-c, --concurrency <n>', 'Max concurrent workers', '4')
  .action(async (tasksJson: string, opts: { concurrency: string }) => {
    let tasks: WorkerTask[];
    try {
      tasks = JSON.parse(tasksJson);
    } catch {
      logger.error('tasksJson must be a JSON array of {profile, prompt} objects');
      process.exitCode = 1;
      return;
    }
    const results = await runFleet(tasks, { concurrency: Number(opts.concurrency) });
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  });
