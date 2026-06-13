import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

vi.mock('../../../src/lib/paths.js', () => ({
  getClaudeProfilesDir: vi.fn(),
}));

import {
  loadRoutingLog,
  appendRoutingEvent,
  flushRoutingLog,
  recentRouting,
  clearRoutingLog,
  routingCategory,
  routingLabel,
} from '../../../src/lib/routing-log.js';
import { getClaudeProfilesDir } from '../../../src/lib/paths.js';

describe('routing-log', () => {
  let tempDir: string;
  let profilesDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-routing-'));
    profilesDir = path.join(tempDir, '.claude-profiles');
    await fs.ensureDir(profilesDir);
    vi.mocked(getClaudeProfilesDir).mockReturnValue(profilesDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  describe('append + load', () => {
    it('returns an empty list before anything is logged', async () => {
      expect(await loadRoutingLog()).toEqual([]);
    });

    it('stamps `at` when the caller omits it', async () => {
      await appendRoutingEvent({ kind: 'launch', to: 'josh', chain: 'default' });
      const events = await loadRoutingLog();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('launch');
      expect(events[0].to).toBe('josh');
      expect(typeof events[0].at).toBe('string');
      expect(Number.isNaN(Date.parse(events[0].at))).toBe(false);
    });

    it('preserves a caller-supplied `at`', async () => {
      const at = '2026-06-12T10:00:00.000Z';
      await appendRoutingEvent({ kind: 'manual', from: 'josh', to: 'lockie', at });
      const events = await loadRoutingLog();
      expect(events[0].at).toBe(at);
    });

    it('appends in chronological order', async () => {
      await appendRoutingEvent({ kind: 'launch', to: 'josh' });
      await appendRoutingEvent({ kind: 'limit', from: 'josh', to: 'lockie' });
      await appendRoutingEvent({ kind: 'manual', from: 'lockie', to: 'josh' });
      const events = await loadRoutingLog();
      expect(events.map((e) => e.kind)).toEqual(['launch', 'limit', 'manual']);
    });

    it('serializes concurrent fire-and-forget appends losslessly', async () => {
      // Issue both without awaiting — the launch + the failover that races it.
      // Without serialization both would load the same empty snapshot and the
      // later write would clobber the earlier event.
      void appendRoutingEvent({ kind: 'launch', to: 'josh', chain: 'default' });
      void appendRoutingEvent({ kind: 'limit', from: 'josh', to: 'lockie', chain: 'default' });
      await flushRoutingLog();
      const events = await loadRoutingLog();
      expect(events.map((e) => e.kind)).toEqual(['launch', 'limit']);
    });

    it('flushRoutingLog resolves once pending writes have landed', async () => {
      void appendRoutingEvent({ kind: 'launch', to: 'josh' });
      await flushRoutingLog();
      expect(await loadRoutingLog()).toHaveLength(1);
    });
  });

  describe('filters', () => {
    beforeEach(async () => {
      await appendRoutingEvent({ kind: 'launch', to: 'josh', chain: 'default' });
      await appendRoutingEvent({ kind: 'limit', from: 'josh', to: 'lockie', chain: 'default' });
      await appendRoutingEvent({ kind: 'manual', from: 'a', to: 'b', chain: 'other' });
    });

    it('filters by chain', async () => {
      const events = await loadRoutingLog({ chain: 'default' });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.chain === 'default')).toBe(true);
    });

    it('filters by kinds', async () => {
      const events = await loadRoutingLog({ kinds: ['manual'] });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('manual');
    });
  });

  describe('recentRouting', () => {
    it('returns the N most recent events (chronological)', async () => {
      for (let i = 0; i < 5; i++) {
        await appendRoutingEvent({ kind: 'launch', to: `p${i}` });
      }
      const recent = await recentRouting(3);
      expect(recent.map((e) => e.to)).toEqual(['p2', 'p3', 'p4']);
    });

    it('scopes to a chain', async () => {
      await appendRoutingEvent({ kind: 'launch', to: 'x', chain: 'a' });
      await appendRoutingEvent({ kind: 'launch', to: 'y', chain: 'b' });
      const recent = await recentRouting(20, 'b');
      expect(recent).toHaveLength(1);
      expect(recent[0].to).toBe('y');
    });
  });

  describe('clear', () => {
    it('empties the log', async () => {
      await appendRoutingEvent({ kind: 'launch', to: 'josh' });
      await clearRoutingLog();
      expect(await loadRoutingLog()).toEqual([]);
    });
  });

  describe('trim to MAX_EVENTS', () => {
    it('keeps only the most recent 1000', async () => {
      // Seed the file just past the cap directly, then append one more.
      const events = Array.from({ length: 1000 }, (_, i) => ({
        at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        kind: 'launch' as const,
        to: `p${i}`,
      }));
      await fs.writeJson(path.join(profilesDir, 'routing-log.json'), { events });
      await appendRoutingEvent({ kind: 'launch', to: 'newest' });
      const after = await loadRoutingLog();
      expect(after).toHaveLength(1000);
      expect(after[after.length - 1].to).toBe('newest');
      // The oldest (p0) should have been dropped.
      expect(after[0].to).toBe('p1');
    });
  });

  describe('corrupt log', () => {
    it('treats unreadable JSON as empty', async () => {
      await fs.writeFile(path.join(profilesDir, 'routing-log.json'), 'not json{');
      expect(await loadRoutingLog()).toEqual([]);
    });
  });
});

describe('routingCategory', () => {
  it('maps manual to deliberate', () => {
    expect(routingCategory('manual')).toBe('deliberate');
  });

  it('maps limit/auth/server to auto-failover', () => {
    expect(routingCategory('limit')).toBe('auto-failover');
    expect(routingCategory('auth')).toBe('auto-failover');
    expect(routingCategory('server')).toBe('auto-failover');
  });

  it('maps launch and exhausted to themselves', () => {
    expect(routingCategory('launch')).toBe('launch');
    expect(routingCategory('exhausted')).toBe('exhausted');
  });
});

describe('routingLabel', () => {
  it('gives deliberate and automatic distinct glyphs', () => {
    expect(routingLabel('manual').glyph).not.toBe(routingLabel('limit').glyph);
    expect(routingLabel('manual').text).toMatch(/manual/i);
    expect(routingLabel('limit').text).toMatch(/auto-failover/i);
  });

  it('uses width-1 glyphs for alignment', () => {
    for (const kind of ['launch', 'manual', 'limit', 'auth', 'server', 'exhausted'] as const) {
      expect([...routingLabel(kind).glyph]).toHaveLength(1);
    }
  });
});
