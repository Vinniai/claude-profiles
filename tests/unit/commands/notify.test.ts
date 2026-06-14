import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

vi.mock('../../../src/lib/paths.js', () => ({
  getClaudeProfilesDir: vi.fn(),
  getConfigPaths: vi.fn(),
}));

import { notifyCommand } from '../../../src/commands/notify.js';
import { loadProfiles, saveProfiles } from '../../../src/lib/profiles.js';
import { getClaudeProfilesDir } from '../../../src/lib/paths.js';

/** Run a `notify` subcommand through commander against the temp config. */
async function runNotify(...argv: string[]): Promise<void> {
  await notifyCommand.parseAsync(['node', 'notify', ...argv]);
}

describe('notify command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-notify-'));
    await fs.ensureDir(tempDir);
    vi.mocked(getClaudeProfilesDir).mockReturnValue(tempDir);
    // Seed a config so save/load have a base to mutate.
    await saveProfiles({ profiles: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it('exposes set / clear / status / test subcommands', () => {
    const names = notifyCommand.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['set', 'clear', 'status', 'test']));
  });

  it('persists a webhook URL on `set`', async () => {
    await runNotify('set', 'https://discord.com/api/webhooks/123/abc');
    const config = await loadProfiles();
    expect(config.notify?.webhookUrl).toBe('https://discord.com/api/webhooks/123/abc');
    expect(config.notify?.events).toBeUndefined();
  });

  it('stores an event filter when --events is given', async () => {
    await runNotify('set', 'https://x.test/hook', '--events', 'waiting, permission');
    const config = await loadProfiles();
    expect(config.notify?.events).toEqual(['waiting', 'permission']);
  });

  it('rejects a non-http URL', async () => {
    await expect(runNotify('set', 'ftp://nope')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('removes the config on `clear`', async () => {
    await runNotify('set', 'https://x.test/hook');
    await runNotify('clear');
    const config = await loadProfiles();
    expect(config.notify).toBeUndefined();
  });

  it('`test` fails clearly when nothing is configured', async () => {
    await expect(runNotify('test')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });
});
