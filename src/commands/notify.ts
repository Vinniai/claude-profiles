import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadProfiles, saveProfiles } from '../lib/profiles.js';
import { buildNotifyPayload } from '../lib/hook-events.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

const orange = chalk.hex('#FF6B4A');

/**
 * `claude-profiles notify` — configure where the Claude Code `Notification`
 * hook forwards its "waiting for input / needs permission" pings. The payload is
 * a Discord-compatible `{ content }` POST (also works for Slack incoming
 * webhooks), so a single webhook URL turns those pings into phone pushes.
 */

function assertWebhook(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    throw new ClaudeProfilesError(
      `"${url}" is not a valid webhook URL`,
      ErrorCode.INVALID_CONFIG,
      'Provide an http(s) URL, e.g. a Discord channel webhook.'
    );
  }
  return url;
}

/** Redact the secret token in a webhook URL for display. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const shown = tail.length > 6 ? `…${tail.slice(-4)}` : '…';
    return `${u.origin}${u.pathname.replace(tail, shown)}`;
  } catch {
    return url;
  }
}

const notifyStatusCommand = new Command('status')
  .description('Show where notifications are forwarded')
  .action(async () => {
    const config = await loadProfiles();
    const n = config.notify;
    logger.heading('Notifications');
    console.log();
    if (!n?.webhookUrl) {
      logger.dim('Not configured — Notification hook pings stay local.');
      logger.dim(
        "Set one with: claude-profiles notify set <webhook-url>"
      );
      return;
    }
    logger.table([
      ['Webhook', orange(maskUrl(n.webhookUrl))],
      [
        'Filter',
        n.events && n.events.length > 0
          ? n.events.join(', ')
          : chalk.dim('(forward all)'),
      ],
    ]);
  });

const notifySetCommand = new Command('set')
  .description('Forward Notification hook pings to a webhook (e.g. Discord)')
  .argument('<url>', 'Webhook URL to POST { content } to')
  .option(
    '--events <list>',
    'Only forward messages containing one of these comma-separated substrings'
  )
  .action(async (url: string, options: { events?: string }) => {
    const webhookUrl = assertWebhook(url);
    const config = await loadProfiles();
    const events = options.events
      ? options.events
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    config.notify = { webhookUrl, ...(events && events.length > 0 ? { events } : {}) };
    await saveProfiles(config);
    logger.success(`Notifications will be forwarded to ${orange(maskUrl(webhookUrl))}.`);
    if (events && events.length > 0) {
      logger.dim(`Only messages containing: ${events.join(', ')}`);
    }
  });

const notifyClearCommand = new Command('clear')
  .description('Stop forwarding notifications')
  .action(async () => {
    const config = await loadProfiles();
    if (!config.notify) {
      logger.dim('Notifications were not configured.');
      return;
    }
    delete config.notify;
    await saveProfiles(config);
    logger.success('Notification forwarding disabled.');
  });

const notifyTestCommand = new Command('test')
  .description('Send a test notification to the configured webhook')
  .option('-m, --message <text>', 'Message body', 'Test notification from claude-profiles')
  .action(async (options: { message: string }) => {
    const config = await loadProfiles();
    if (!config.notify?.webhookUrl) {
      throw new ClaudeProfilesError(
        'No webhook configured',
        ErrorCode.INVALID_CONFIG,
        'Run: claude-profiles notify set <webhook-url>'
      );
    }
    const { content } = buildNotifyPayload({ message: options.message });
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).catch((e: unknown) => {
      throw new ClaudeProfilesError(
        `Failed to reach the webhook: ${String(e)}`,
        ErrorCode.INVALID_CONFIG
      );
    });
    if (!res.ok) {
      throw new ClaudeProfilesError(
        `Webhook returned ${res.status} ${res.statusText}`,
        ErrorCode.INVALID_CONFIG
      );
    }
    logger.success('Test notification sent.');
  });

export const notifyCommand = new Command('notify')
  .description('Configure forwarding of Claude Code notifications to a webhook')
  .addCommand(notifyStatusCommand)
  .addCommand(notifySetCommand)
  .addCommand(notifyClearCommand)
  .addCommand(notifyTestCommand);
