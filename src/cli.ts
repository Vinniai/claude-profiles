import { Command } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'module';
import {
  initCommand,
  pullCommand,
  pushCommand,
  statusCommand,
  profileCommand,
  createCommand,
  loginCommand,
  syncCommand,
  runCommand,
  chainCommand,
  handoffCommand,
  hookCommand,
  strategyCommand,
  usageCommand,
  statuslineCommand,
  cutoverCommand,
  paceCommand,
  channelCommand,
} from './commands/index.js';
import { ClaudeProfilesError } from './types/index.js';
import { printLogo } from './utils/logo.js';
import { logger } from './utils/logger.js';
import { loadProfiles } from './lib/profiles.js';
import { loadState } from './lib/state.js';
import { buildStatusRows } from './lib/status.js';
import { printStatusDashboard, paceSummaryLine } from './lib/render.js';
import { parseProfileToken } from './lib/profile-spec.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

// `run` flags the shortcut keeps in front of the `--` so they reach the router
// (everything else after the profile tokens is forwarded to `claude`).
const RUN_BOOL_FLAGS = new Set([
  '--interactive',
  '--headless',
  '--new',
  '--failover',
  '--balanced',
  '--weighted',
  '--least-used',
  '--most-remaining',
]);
const RUN_VALUE_FLAGS = ['--strategy', '--min-session', '--min-weekly'];

/**
 * Split the tokens that follow the profile name(s) into `run`-control flags
 * (kept before `--`) and the residual `claude` args (placed after `--`). An
 * explicit `--` ends the scan immediately. Run flags must precede claude args.
 */
function splitRunFlags(rest: string[]): { runFlags: string[]; claudeArgs: string[] } {
  const runFlags: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const t = rest[i];
    if (t === '--') {
      i += 1;
      break;
    }
    if (RUN_BOOL_FLAGS.has(t)) {
      runFlags.push(t);
      i += 1;
      continue;
    }
    const valueFlag = RUN_VALUE_FLAGS.find((f) => t === f || t.startsWith(`${f}=`));
    if (valueFlag) {
      if (t.includes('=')) {
        runFlags.push(t);
        i += 1;
      } else {
        runFlags.push(t);
        if (i + 1 < rest.length) runFlags.push(rest[i + 1]);
        i += 2;
      }
      continue;
    }
    break;
  }
  return { runFlags, claudeArgs: rest.slice(i) };
}

/**
 * Ergonomic shortcut. Lets these work without typing `run --…`:
 *
 *   claude-profiles josh -- -p "hi"             → run --profile josh -- …
 *   claude-profiles josh lockie --balanced      → run --balanced --profiles josh,lockie -- …
 *   claude-profiles josh:3 lockie:1 -- -p "hi"  → run --profiles josh:3,lockie:1 -- …
 *   claude-profiles default -- -p "hi"          → run --chain default -- …
 *
 * Only fires when the leading token is NOT a known subcommand/option. One
 * profile (no weight) keeps single-profile semantics (no fallback); two or more
 * profiles, or any inline weight, become an ad-hoc chain via `--profiles`. A
 * lone chain name maps to `--chain`. Profiles win over chains on a name clash.
 */
export async function expandProfileShortcut(
  argv: string[],
  program: Command
): Promise<string[]> {
  // argv is [node, script, token, ...rest]
  const first = argv[2];
  if (!first || first.startsWith('-')) return argv;

  // Don't shadow real subcommands or their aliases, or help/version.
  const known = new Set<string>(['help']);
  for (const cmd of program.commands) {
    known.add(cmd.name());
    for (const a of cmd.aliases()) known.add(a);
  }
  if (known.has(first)) return argv;

  let config;
  try {
    config = await loadProfiles();
  } catch {
    return argv;
  }
  const profiles = config.profiles ?? {};
  const isProfile = (name: string) =>
    Object.prototype.hasOwnProperty.call(profiles, name);

  const head = argv.slice(0, 2);
  const firstToken = parseProfileToken(first);

  // Leading token is a configured profile → collect the consecutive run of
  // profile tokens into an ad-hoc chain.
  if (firstToken && isProfile(firstToken.name)) {
    const names: string[] = [];
    const weights: Record<string, number> = {};
    let i = 2;
    for (; i < argv.length; i++) {
      const t = argv[i];
      if (t.startsWith('-')) break;
      const tok = parseProfileToken(t);
      if (!tok || !isProfile(tok.name) || names.includes(tok.name)) break;
      names.push(tok.name);
      if (tok.weight != null) weights[tok.name] = tok.weight;
    }

    const { runFlags, claudeArgs } = splitRunFlags(argv.slice(i));
    const hasWeights = Object.keys(weights).length > 0;

    const selector =
      names.length === 1 && !hasWeights
        ? ['--profile', names[0]]
        : [
            '--profiles',
            names
              .map((n) => (weights[n] != null ? `${n}:${weights[n]}` : n))
              .join(','),
          ];

    return [...head, 'run', ...runFlags, ...selector, '--', ...claudeArgs];
  }

  // Otherwise a lone chain name still works.
  if (config.chains && Object.prototype.hasOwnProperty.call(config.chains, first)) {
    const { runFlags, claudeArgs } = splitRunFlags(argv.slice(3));
    return [...head, 'run', ...runFlags, '--chain', first, '--', ...claudeArgs];
  }

  return argv;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('claude-profiles')
    .description(
      'Manage multiple Claude Code profiles, route across OAuth accounts, and fall back on limit errors'
    )
    .version(VERSION)
    // Allow `run` to forward unknown options through to `claude`.
    .enablePositionalOptions()
    .addHelpText('before', () => {
      printLogo();
      return '';
    });

  program.addCommand(profileCommand);
  // Root-level shortcuts: `claude-profiles create <name>` / `login <name>`.
  program.addCommand(createCommand);
  program.addCommand(loginCommand);
  program.addCommand(chainCommand);
  program.addCommand(runCommand);
  program.addCommand(strategyCommand);
  program.addCommand(usageCommand);
  program.addCommand(statuslineCommand);
  program.addCommand(cutoverCommand);
  program.addCommand(paceCommand);
  program.addCommand(channelCommand);
  program.addCommand(handoffCommand);
  program.addCommand(initCommand);
  program.addCommand(syncCommand);

  // Hidden internal dispatcher invoked by Claude Code hooks.
  program.addCommand(hookCommand, { hidden: true });

  // Deprecated — kept as hidden commands with redirect messages
  program.addCommand(pullCommand);
  program.addCommand(pushCommand);
  program.addCommand(statusCommand);

  return program;
}

/** Commands hidden from the landing screen's quick-reference. */
const LANDING_HIDDEN = new Set(['help', 'hook', 'pull', 'push', 'status']);

/**
 * The bare `claude-profiles` (no-arg) landing screen: lead with the user's
 * profiles and their usage limits, then a compact command quick-reference.
 * Stays fully offline (no `claude` spawn) so it renders instantly.
 */
async function showLanding(program: Command): Promise<void> {
  printLogo();

  let hasProfiles = false;
  try {
    const config = await loadProfiles();
    const names = Object.keys(config.profiles ?? {});
    if (names.length > 0) {
      hasProfiles = true;
      const state = await loadState();
      const rows = await buildStatusRows(config, state, { offline: true });
      logger.heading('Your profiles');
      console.log();
      printStatusDashboard(rows);
      const pace = paceSummaryLine(rows);
      if (pace) {
        console.log();
        console.log(pace);
      }
      console.log();
    }
  } catch {
    // Not initialized / unreadable config — fall through to the command help.
  }

  if (!hasProfiles) {
    logger.dim('No profiles configured yet.');
    logger.dim('Get started:  claude-profiles create <name>   then   claude-profiles login <name>');
    console.log();
  }

  logger.heading('Commands');
  const rows: [string, string][] = [];
  for (const cmd of program.commands) {
    const name = cmd.name();
    // `Command` carries an undocumented `_hidden` flag for `{ hidden: true }`.
    const hidden = (cmd as unknown as { _hidden?: boolean })._hidden;
    if (hidden || LANDING_HIDDEN.has(name)) continue;
    rows.push([name, cmd.description()]);
  }
  logger.table(rows);
  console.log();
  logger.dim('Run a profile:   claude-profiles <profile> -- -p "hi"');
  logger.dim('Full help:       claude-profiles --help');
}

export async function run(argv: string[]): Promise<void> {
  const program = createProgram();

  // Global error handling
  program.exitOverride();

  // Bare invocation → a profiles-first landing screen instead of raw help.
  if (argv.length <= 2) {
    try {
      await showLanding(program);
    } catch (err) {
      if (process.env.DEBUG) console.error(err);
    }
    return;
  }

  try {
    const expanded = await expandProfileShortcut(argv, program);
    await program.parseAsync(expanded);
  } catch (err) {
    if (err instanceof ClaudeProfilesError) {
      console.error(chalk.red('error') + ' ' + err.message);
      if (err.suggestion) {
        console.log('\n' + chalk.dim('Suggestion: ') + err.suggestion);
      }
      process.exit(1);
    }

    // Commander errors (like --help, --version)
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code: string }).code;
      if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') {
        process.exit(0);
      }
    }

    // Unexpected error
    console.error(chalk.red('error') + ' An unexpected error occurred');
    if (process.env.DEBUG) {
      console.error(err);
    } else {
      console.log(chalk.dim('Run with DEBUG=1 for more details'));
    }
    process.exit(1);
  }
}
