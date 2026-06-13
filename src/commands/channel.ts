import { Command } from 'commander';
import { startChannelServer } from '../channel/server.js';

interface ChannelOptions {
  port: string;
  stdio: boolean;
  http: boolean;
  poll: string;
}

/**
 * `claude-profiles channel` — run the claude-profiles Channel (a Claude Code
 * channel / MCP server). Normally launched by `claude` itself via `.mcp.json`,
 * so it inherits the session's CLAUDE_CONFIG_DIR + chain and can push account
 * health events into the session and accept deliberate `switch_account` calls.
 *
 * Run it standalone with `--no-stdio` to drive the HTTP control face from curl
 * (useful for testing failover without a live session).
 */
export const channelCommand = new Command('channel')
  .description(
    'Run the claude-profiles Channel: push account-health events into a Claude session and accept mid-run account switches'
  )
  .option('-p, --port <port>', 'Localhost HTTP control port (0 to disable)', '8799')
  .option('--no-stdio', 'Skip the MCP stdio transport (HTTP-only test mode)')
  .option('--no-http', 'Disable the HTTP control face')
  .option('--poll <ms>', 'State-file poll interval in ms', '1500')
  .action(async (options: ChannelOptions) => {
    const handle = await startChannelServer({
      port: options.http ? Number(options.port) : 0,
      stdio: options.stdio,
      pollMs: Number(options.poll),
    });

    // Keep the process alive; shut down cleanly on signals.
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    // Resolve never (the server runs until killed).
    await new Promise<void>(() => {});
  });
