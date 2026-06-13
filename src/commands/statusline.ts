import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { loadProfiles } from '../lib/profiles.js';
import { profileNameForConfigDir } from '../lib/handoff.js';
import { recordUsage, getProfileState, recordBurn } from '../lib/state.js';
import { effectivePolicy, upNextForChain } from '../lib/router.js';
import {
  computeCutover,
  updateBurnRate,
  type CutoverInfo,
  type UpNext,
} from '../lib/cutover.js';
import {
  renderStatusLine,
  budgetFromStatusLine,
  plainPainter,
  type StatusLineInput,
  type Painter,
} from '../lib/statusline-render.js';
import {
  installStatusLine,
  removeStatusLine,
  statusLineInstalled,
} from '../lib/statusline-install.js';
import { getSettingsPath } from '../lib/hooks-install.js';
import { logger } from '../utils/logger.js';

/**
 * `claude-profiles statusline`
 *
 * Default (no flags): a Claude Code statusLine provider. Reads the session JSON
 * Claude Code pipes on stdin, prints ONE line leading with the account this
 * session runs under (recovered from CLAUDE_CONFIG_DIR) followed by git branch,
 * model, project and a live 5-hour rate-limit bar. The rate data is free — it
 * comes from `rate_limits` in the stdin JSON, no API call. As a side effect it
 * caches the account's usage snapshot so `chain status` and the routing
 * strategies see fresh, zero-cost limit data.
 *
 * `--install` / `--uninstall`: wire this command into the shared settings.json.
 */

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const to = setTimeout(() => resolve(data), 2000);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(to);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(to);
      resolve(data);
    });
  });
}

function parseInput(raw: string): StatusLineInput {
  try {
    return JSON.parse(raw) as StatusLineInput;
  } catch {
    return {};
  }
}

/** Read the current git branch from a directory, best-effort, no spawn. */
function gitBranchFor(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    let gitPath = path.join(dir, '.git');
    const stat = fs.statSync(gitPath);
    // Worktrees use a `.git` FILE: `gitdir: /abs/path`.
    if (stat.isFile()) {
      const pointer = fs.readFileSync(gitPath, 'utf-8').trim();
      const m = pointer.match(/^gitdir:\s*(.+)$/);
      if (!m) return undefined;
      gitPath = m[1];
    }
    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf-8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1];
    return head.slice(0, 7); // detached HEAD → short sha
  } catch {
    return undefined;
  }
}

/** Choose a colored or plain painter, honoring NO_COLOR / non-TTY. */
function pickPainter(): Painter {
  if (process.env.NO_COLOR != null || !chalk.level) return plainPainter;
  return {
    ok: (s) => chalk.green(s),
    warn: (s) => chalk.yellow(s),
    crit: (s) => chalk.red(s),
    dim: (s) => chalk.dim(s),
    bold: (s) => chalk.bold(s),
  };
}

/** The default statusLine provider path: stdin → one line on stdout. */
async function renderFromStdin(): Promise<void> {
  const now = new Date();
  const input = parseInput(await readStdin());
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const chain = process.env.CLAUDE_PROFILES_CHAIN || undefined;

  // Resolve the account name (best-effort); fall back to the dir basename.
  let config: Awaited<ReturnType<typeof loadProfiles>> | undefined;
  let account: string | undefined;
  try {
    config = await loadProfiles();
    account = profileNameForConfigDir(config.profiles, configDir);
  } catch {
    /* ignore */
  }
  if (!account && configDir) {
    const base = path.basename(configDir).replace(/^\.claude-?/, '');
    account = base || undefined;
  }

  if (!input.gitBranch) {
    input.gitBranch = gitBranchFor(
      input.workspace?.current_dir ?? input.workspace?.project_dir,
    );
  }

  const budget = budgetFromStatusLine(input, now);
  let cutover: CutoverInfo | undefined;
  let upNext: UpNext | undefined;

  // Side effect: cache the live snapshot + burn rate for chain status / routing,
  // and compute the cutover countdown + up-next. All best-effort — persistence
  // and routing math must never break the status bar. The statusLine fires
  // often, so we only rewrite state.json when a percentage actually moves.
  try {
    if (account && config) {
      const prevState = await getProfileState(account);
      const policy = effectivePolicy(config, chain, account);

      if (budget) {
        const prevUsage = prevState.usage;
        const moved =
          budget.session?.usedPct !== prevUsage?.session?.usedPct ||
          budget.weekly?.usedPct !== prevUsage?.weekly?.usedPct;
        if (moved) {
          const burn = updateBurnRate(
            prevUsage?.session,
            budget.session,
            prevState.burn,
            now,
          );
          await recordUsage(account, budget);
          if (burn) await recordBurn(account, burn);
        }
      }

      cutover = computeCutover({
        session: budget?.session,
        policy,
        override: prevState.capOverride,
        burn: prevState.burn,
        now,
      });
      upNext = await upNextForChain({
        config,
        chain,
        account,
        liveUsage: budget,
        now,
      });
    }
  } catch {
    /* never let persistence or routing math break the status bar */
  }

  process.stdout.write(
    renderStatusLine(input, { account, now, painter: pickPainter(), cutover, upNext }),
  );
}

export const statuslineCommand = new Command('statusline')
  .description(
    'Claude Code status-line provider: account + git + model + 5h rate-limit bar',
  )
  .option('--install', 'Install this as the statusLine in shared settings.json')
  .option('--uninstall', 'Remove the statusLine from shared settings.json')
  .option('--force', 'With --install, overwrite an existing custom statusLine')
  .option('--weekly', '(reserved) also show the 7-day window')
  .action(async (opts: { install?: boolean; uninstall?: boolean; force?: boolean }) => {
    if (opts.install) {
      const { installed, conflict } = await installStatusLine(
        getSettingsPath(),
        undefined,
        opts.force,
      );
      if (installed) {
        logger.success('Installed claude-profiles status line in ~/.claude/settings.json.');
        logger.dim('Restart Claude Code to see it. Each session shows its own account + limits.');
      } else {
        logger.warn(`A different statusLine is already set: ${conflict}`);
        logger.dim('Re-run with --force to replace it.');
      }
      return;
    }
    if (opts.uninstall) {
      const removed = await removeStatusLine();
      logger[removed ? 'success' : 'info'](
        removed
          ? 'Removed claude-profiles status line from settings.json.'
          : 'No claude-profiles status line was installed.',
      );
      return;
    }
    // No flags: act as the statusLine provider (stdin → one line).
    if (process.stdin.isTTY) {
      // Invoked by a human without piped input — show install state, not a hang.
      const installed = await statusLineInstalled();
      logger.info(
        installed
          ? 'Status line is installed. Claude Code pipes session JSON here on each render.'
          : "Status line not installed. Run 'claude-profiles statusline --install'.",
      );
      return;
    }
    await renderFromStdin();
  });
