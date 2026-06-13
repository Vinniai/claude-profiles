import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { loadProfiles } from '../lib/profiles.js';
import { loadState } from '../lib/state.js';
import { buildStatusRows } from '../lib/status.js';
import { renderPaceView, type StatusRow, type PaceRecommendation } from '../lib/render.js';
import { formatSpan } from '../lib/pace.js';

/**
 * `claude-profiles pace` — efficiency cockpit.
 *
 * Lays every account's session/weekly reset onto a shared RESETS timeline, then
 * scores each account's burn against the IDEAL pace (the %/min that lands you at
 * the cap exactly when the window resets) so you can see who is burning too fast,
 * who is leaving budget on the table, and which account to use right now to be
 * the most efficient.
 */

/** A short, human reason for the recommendation from the picked row's pace. */
function recommendationFor(rows: StatusRow[], now: Date): PaceRecommendation | undefined {
  const pick = rows.find((r) => r.upNext);
  if (!pick) return undefined;

  const bits: string[] = [];
  const p = pick.pace;
  if (p?.binding === 'session' && pick.session?.resetAt) {
    const ms = Date.parse(pick.session.resetAt) - now.getTime();
    bits.push(`drain its ${formatSpan(Math.max(0, ms) / 60_000)} session window`);
  } else if (p?.session?.verdict === 'underusing') {
    bits.push('session budget going unspent');
  } else if (p?.session?.verdict === 'idle') {
    bits.push('session idle with headroom');
  }
  if (p?.weekly?.verdict === 'underusing') bits.push('weekly healthy');
  else if (p?.weekly?.verdict === 'too-fast') bits.push('but weekly running ahead');

  return { name: pick.name, reason: bits.length ? bits.join('; ') : undefined };
}

export const paceCommand = new Command('pace')
  .description('Efficiency cockpit: reset timeline + per-account pace verdict + best pick')
  .option('-c, --chain <name>', 'Chain context for cap / up-next computation')
  .option('--live', 'Probe live login status (slower; spawns claude)')
  .option('-w, --width <cols>', 'Timeline track width in columns', '32')
  .action(async (options: { chain?: string; live?: boolean; width?: string }) => {
    const now = new Date();
    const config = await loadProfiles();
    const state = await loadState();

    if (Object.keys(config.profiles).length === 0) {
      logger.dim('No profiles configured.');
      logger.dim('Get started:  claude-profiles create <name>   then   claude-profiles login <name>');
      return;
    }

    const rows = await buildStatusRows(config, state, {
      offline: !options.live,
      chain: options.chain,
      now,
    });

    const width = Math.max(16, Number(options.width) || 32);
    logger.heading(`Pace${options.chain ? ` · chain "${options.chain}"` : ''}`);
    console.log();
    console.log(
      renderPaceView({ rows, recommendation: recommendationFor(rows, now), now, width })
    );
    console.log();
  });
