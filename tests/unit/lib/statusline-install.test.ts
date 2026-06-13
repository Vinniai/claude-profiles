import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  installStatusLine,
  removeStatusLine,
  statusLineInstalled,
} from '../../../src/lib/statusline-install.js';

describe('statusline install', () => {
  let dir: string;
  let settingsPath: string;
  const BIN = 'claude-profiles';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-sl-'));
    settingsPath = path.join(dir, 'settings.json');
  });
  afterEach(async () => {
    await fs.remove(dir);
  });

  it('installs our statusLine into a fresh settings file', async () => {
    const r = await installStatusLine(settingsPath, BIN);
    expect(r.installed).toBe(true);
    expect(await statusLineInstalled(settingsPath)).toBe(true);
    const s = await fs.readJson(settingsPath);
    expect(s.statusLine.command).toBe('claude-profiles statusline');
    expect(s.statusLine.type).toBe('command');
  });

  it('is idempotent (re-install does not duplicate or error)', async () => {
    await installStatusLine(settingsPath, BIN);
    const r = await installStatusLine(settingsPath, BIN);
    expect(r.installed).toBe(true);
    expect(await statusLineInstalled(settingsPath)).toBe(true);
  });

  it('refuses to clobber a different statusLine unless forced', async () => {
    await fs.writeJson(settingsPath, {
      statusLine: { type: 'command', command: '/usr/local/bin/my-bar' },
    });
    const blocked = await installStatusLine(settingsPath, BIN);
    expect(blocked.installed).toBe(false);
    expect(blocked.conflict).toBe('/usr/local/bin/my-bar');
    // still the user's bar
    expect((await fs.readJson(settingsPath)).statusLine.command).toBe('/usr/local/bin/my-bar');

    const forced = await installStatusLine(settingsPath, BIN, true);
    expect(forced.installed).toBe(true);
    expect((await fs.readJson(settingsPath)).statusLine.command).toBe('claude-profiles statusline');
  });

  it('preserves unrelated settings keys on install', async () => {
    await fs.writeJson(settingsPath, { model: 'opus', hooks: { Stop: [] } });
    await installStatusLine(settingsPath, BIN);
    const s = await fs.readJson(settingsPath);
    expect(s.model).toBe('opus');
    expect(s.hooks).toEqual({ Stop: [] });
    expect(s.statusLine.command).toBe('claude-profiles statusline');
  });

  it('removes only our statusLine, and reports when nothing to remove', async () => {
    await installStatusLine(settingsPath, BIN);
    expect(await removeStatusLine(settingsPath)).toBe(true);
    expect(await statusLineInstalled(settingsPath)).toBe(false);
    // second remove is a no-op
    expect(await removeStatusLine(settingsPath)).toBe(false);
  });

  it('leaves a user-defined statusLine intact on remove', async () => {
    await fs.writeJson(settingsPath, {
      statusLine: { type: 'command', command: '/usr/local/bin/my-bar' },
    });
    expect(await removeStatusLine(settingsPath)).toBe(false);
    expect((await fs.readJson(settingsPath)).statusLine.command).toBe('/usr/local/bin/my-bar');
  });
});
