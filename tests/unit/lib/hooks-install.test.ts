import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

vi.mock('../../../src/lib/paths.js', () => ({
  detectClaudeConfigDir: vi.fn(),
}));

import {
  installHooks,
  removeHooks,
  hooksInstalled,
  ensureHooksInstalled,
  getSettingsPath,
  HOOK_EVENTS,
} from '../../../src/lib/hooks-install.js';
import { detectClaudeConfigDir } from '../../../src/lib/paths.js';

describe('hooks-install', () => {
  let tempDir: string;
  let settingsPath: string;
  const BIN = 'claude-profiles';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-hooks-'));
    settingsPath = path.join(tempDir, 'settings.json');
    vi.mocked(detectClaudeConfigDir).mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it('getSettingsPath uses the detected claude dir', () => {
    expect(getSettingsPath()).toBe(settingsPath);
  });

  it('installs a group for every hook event', async () => {
    await installHooks(settingsPath, BIN);
    const settings = await fs.readJson(settingsPath);
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event]).toBeDefined();
      const cmd = settings.hooks[event][0].hooks[0].command;
      expect(cmd).toBe(`${BIN} _hook ${event}`);
    }
    expect(await hooksInstalled(settingsPath)).toBe(true);
  });

  it('is idempotent — re-installing does not duplicate groups', async () => {
    await installHooks(settingsPath, BIN);
    await installHooks(settingsPath, BIN);
    const settings = await fs.readJson(settingsPath);
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
  });

  it('preserves unrelated user hooks on install and remove', async () => {
    await fs.writeJson(settingsPath, {
      model: 'opus',
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'echo user-hook' }] },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] },
        ],
      },
    });

    await installHooks(settingsPath, BIN);
    let settings = await fs.readJson(settingsPath);
    // User's Stop hook survives alongside ours.
    const stopCmds = settings.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command)
    );
    expect(stopCmds).toContain('echo user-hook');
    expect(stopCmds).toContain(`${BIN} _hook Stop`);
    // Unrelated keys untouched.
    expect(settings.model).toBe('opus');
    expect(settings.hooks.PreToolUse).toBeDefined();

    const removed = await removeHooks(settingsPath);
    expect(removed).toBe(true);
    settings = await fs.readJson(settingsPath);
    // Ours gone, user's preserved.
    const stopAfter = settings.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command)
    );
    expect(stopAfter).toEqual(['echo user-hook']);
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.model).toBe('opus');
  });

  it('removeHooks returns false when nothing of ours is present', async () => {
    await fs.writeJson(settingsPath, { hooks: {} });
    expect(await removeHooks(settingsPath)).toBe(false);
  });

  it('ensureHooksInstalled installs once, then is a no-op', async () => {
    expect(await ensureHooksInstalled(settingsPath)).toBe(true);
    expect(await ensureHooksInstalled(settingsPath)).toBe(false);
  });

  it('drops the hooks key entirely when only ours existed', async () => {
    await installHooks(settingsPath, BIN);
    await removeHooks(settingsPath);
    const settings = await fs.readJson(settingsPath);
    expect(settings.hooks).toBeUndefined();
  });
});
