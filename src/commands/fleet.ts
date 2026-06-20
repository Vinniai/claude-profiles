import { Command } from 'commander';
import { spawn } from 'child_process';
import { startFleetServer } from '../fleet/server.js';
import {
  startRemoteControl,
  launchCoordinator,
  selfInvocation,
} from '../fleet/orchestrator.js';
import {
  dispatch,
  runFleet,
  fleetStatus,
  resolveProfile,
  type WorkerTask,
} from '../lib/fleet.js';
import { getProfileProvider, loadProfiles, saveProfiles } from '../lib/profiles.js';
import { logger } from '../utils/logger.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

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
    'Run the fleet MCP server so an orchestrator can delegate work across Claude and Codex account profiles',
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
  .command('install <profile>')
  .description('Register the fleet MCP server in a Claude or Codex profile')
  .action(async (profileName: string) => {
    const profile = await resolveProfile(profileName);
    const provider = getProfileProvider(profile);
    const self = selfInvocation();
    const bin =
      provider === 'codex'
        ? process.env.CLAUDE_PROFILES_CODEX_BIN || 'codex'
        : process.env.CLAUDE_PROFILES_CLAUDE_BIN || 'claude';
    const args =
      provider === 'codex'
        ? ['mcp', 'add', 'fleet', '--', self.command, ...self.args, 'fleet', '--no-http']
        : [
            'mcp',
            'add',
            'fleet',
            '--scope',
            'user',
            '--',
            self.command,
            ...self.args,
            'fleet',
            '--no-http',
          ];
    const env =
      provider === 'codex'
        ? { ...process.env, CODEX_HOME: profile.configDir }
        : { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir };

    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(bin, args, { env, stdio: 'inherit' });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(
            new ClaudeProfilesError(
              `Could not find "${bin}" on PATH`,
              provider === 'codex'
                ? ErrorCode.CODEX_NOT_FOUND
                : ErrorCode.CLAUDE_NOT_FOUND,
            ),
          );
          return;
        }
        reject(err);
      });
      child.on('close', (status) => resolve(status ?? 1));
    });
    if (code !== 0) {
      throw new ClaudeProfilesError(
        `Failed to register fleet MCP in "${profileName}"`,
        ErrorCode.INVALID_CONFIG,
        'Remove an existing fleet registration first, then retry.',
      );
    }
    logger.success(`Fleet MCP registered for ${provider} profile "${profileName}".`);
  });

const routeCommand = new Command('route').description(
  'Manage task-type assignments used by MCP delegate(taskType=...)',
);

routeCommand
  .command('set <taskType>')
  .requiredOption('--profiles <list>', 'Ordered comma-separated profiles')
  .option('--claude-model <model>', 'Claude model for this task route')
  .option('--codex-model <model>', 'Codex model for this task route')
  .option('--skills <list>', 'Comma-separated skills requested on every provider')
  .option('--claude-skills <list>', 'Additional Claude-only skills')
  .option('--codex-skills <list>', 'Additional Codex-only skills, e.g. imagegen')
  .action(async (taskType: string, opts: {
    profiles: string;
    claudeModel?: string;
    codexModel?: string;
    skills?: string;
    claudeSkills?: string;
    codexSkills?: string;
  }) => {
    const config = await loadProfiles();
    const names = opts.profiles
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const unknown = names.filter((name) => !config.profiles[name]);
    if (!names.length || unknown.length) {
      throw new ClaudeProfilesError(
        unknown.length
          ? `Unknown profile${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
          : 'A task route requires at least one profile',
        ErrorCode.PROFILE_NOT_FOUND,
      );
    }
    config.taskRouting ??= {};
    const list = (value?: string): string[] | undefined => {
      if (!value) return undefined;
      const values = [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))];
      return values.length ? values : undefined;
    };
    const rich =
      opts.claudeModel ||
      opts.codexModel ||
      opts.skills ||
      opts.claudeSkills ||
      opts.codexSkills;
    config.taskRouting[taskType] = rich
      ? {
          profiles: [...new Set(names)],
          models: {
            claude: opts.claudeModel,
            codex: opts.codexModel,
          },
          skills: list(opts.skills),
          providerSkills: {
            claude: list(opts.claudeSkills),
            codex: list(opts.codexSkills),
          },
        }
      : [...new Set(names)];
    await saveProfiles(config);
    logger.success(`Task route "${taskType}": ${[...new Set(names)].join(' → ')}`);
  });

routeCommand
  .command('list')
  .action(async () => {
    const routes = (await loadProfiles()).taskRouting ?? {};
    if (!Object.keys(routes).length) {
      logger.dim('No task routes configured.');
      return;
    }
    for (const [taskType, route] of Object.entries(routes)) {
      if (Array.isArray(route)) {
        logger.info(`${taskType}: ${route.join(' → ')}`);
        continue;
      }
      const details = [
        route.models?.claude ? `claude=${route.models.claude}` : undefined,
        route.models?.codex ? `codex=${route.models.codex}` : undefined,
        route.skills?.length ? `skills=${route.skills.join(',')}` : undefined,
        route.providerSkills?.claude?.length
          ? `claude-skills=${route.providerSkills.claude.join(',')}`
          : undefined,
        route.providerSkills?.codex?.length
          ? `codex-skills=${route.providerSkills.codex.join(',')}`
          : undefined,
      ].filter(Boolean);
      logger.info(
        `${taskType}: ${route.profiles.join(' → ')}${details.length ? `  (${details.join('; ')})` : ''}`,
      );
    }
  });

routeCommand
  .command('delete <taskType>')
  .action(async (taskType: string) => {
    const config = await loadProfiles();
    if (!config.taskRouting?.[taskType]) {
      throw new ClaudeProfilesError(
        `Task route "${taskType}" not found`,
        ErrorCode.INVALID_CONFIG,
      );
    }
    delete config.taskRouting[taskType];
    await saveProfiles(config);
    logger.success(`Deleted task route "${taskType}".`);
  });

fleetCommand.addCommand(routeCommand);

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
  .option('--fresh', 'Start a clean conversation instead of resuming this name\'s last session')
  .action(
    async (opts: { lead: string; name?: string; server?: boolean; permissionMode?: string; fresh?: boolean }) => {
      const code = await launchCoordinator({
        lead: opts.lead,
        name: opts.name ?? `Fleet coordinator (${opts.lead})`,
        server: opts.server,
        permissionMode: opts.permissionMode,
        fresh: opts.fresh,
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
