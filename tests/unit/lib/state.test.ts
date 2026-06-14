import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

vi.mock('../../../src/lib/paths.js', () => ({
  getClaudeProfilesDir: vi.fn(),
}));

import {
  loadState,
  setProfileCooldown,
  markNeedsAuth,
  markUsed,
} from '../../../src/lib/state.js';
import { getClaudeProfilesDir } from '../../../src/lib/paths.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

describe('state concurrency', () => {
  let tempDir: string;
  let profilesDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-state-'));
    profilesDir = path.join(tempDir, '.claude-profiles');
    await fs.ensureDir(profilesDir);
    vi.mocked(getClaudeProfilesDir).mockReturnValue(profilesDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it('does not lose concurrent read-modify-write updates to different profiles', async () => {
    // Two writers race on state.json. Without serialization they both read the
    // same empty file and the second save clobbers the first → one update lost.
    await Promise.all([
      setProfileCooldown('a', new Date(NOW.getTime() + 3_600_000), 'limit a', NOW),
      markNeedsAuth('b', 'auth b', NOW),
    ]);

    const state = await loadState();
    expect(state.profiles.a?.cooldownUntil).toBeDefined();
    expect(state.profiles.b?.needsAuth).toBe(true);
  });

  it('survives many concurrent writers without dropping any profile', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
    await Promise.all(names.map((n) => markUsed(n, NOW)));

    const state = await loadState();
    for (const n of names) {
      expect(state.profiles[n]?.lastUsedAt).toBe(NOW.toISOString());
    }
  });

  it('does not leave a stale lock file behind after writing', async () => {
    await markUsed('a', NOW);
    const entries = await fs.readdir(profilesDir);
    expect(entries.some((e) => e.endsWith('.lock'))).toBe(false);
  });
});
