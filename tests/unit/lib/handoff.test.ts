import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

vi.mock('../../../src/lib/paths.js', () => ({
  getClaudeProfilesDir: vi.fn(),
}));

import {
  loadHandoff,
  updateHandoff,
  clearHandoff,
  clearAllHandoffs,
  listHandoffs,
  parseTranscript,
  summarizeTranscript,
  buildContinuationContext,
  profileNameForConfigDir,
  newThreadId,
} from '../../../src/lib/handoff.js';
import { getClaudeProfilesDir } from '../../../src/lib/paths.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

describe('handoff', () => {
  let tempDir: string;
  let profilesDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-handoff-'));
    profilesDir = path.join(tempDir, '.claude-profiles');
    await fs.ensureDir(profilesDir);
    vi.mocked(getClaudeProfilesDir).mockReturnValue(profilesDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  describe('record IO', () => {
    it('returns null for an unknown chain', async () => {
      expect(await loadHandoff('nope')).toBeNull();
    });

    it('creates and round-trips a record', async () => {
      const rec = await updateHandoff(
        'default',
        { lastProfile: 'josh', summary: 'hello', pendingFailover: true },
        NOW
      );
      expect(rec.chain).toBe('default');
      expect(rec.threadId).toMatch(/^default-/);

      const loaded = await loadHandoff('default');
      expect(loaded?.lastProfile).toBe('josh');
      expect(loaded?.pendingFailover).toBe(true);
      expect(loaded?.summary).toBe('hello');
    });

    it('merges patches without losing the thread id', async () => {
      const a = await updateHandoff('default', { lastProfile: 'josh' }, NOW);
      const b = await updateHandoff('default', { pendingFailover: false }, NOW);
      expect(b.threadId).toBe(a.threadId);
      expect(b.lastProfile).toBe('josh');
    });

    it('clears a single chain and all chains', async () => {
      await updateHandoff('default', {}, NOW);
      await updateHandoff('work', {}, NOW);
      await clearHandoff('default');
      expect(await loadHandoff('default')).toBeNull();
      expect(await loadHandoff('work')).not.toBeNull();

      await clearAllHandoffs();
      expect(await listHandoffs()).toEqual([]);
    });

    it('sanitises chain names to avoid path traversal', async () => {
      await updateHandoff('../evil', { summary: 'x' }, NOW);
      // Nothing should be written outside the handoff dir.
      const escaped = path.join(tempDir, 'evil');
      expect(await fs.pathExists(escaped)).toBe(false);
    });
  });

  describe('parseTranscript / summarizeTranscript', () => {
    const transcript = [
      JSON.stringify({ type: 'user', message: { content: 'What is 2+2?' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'It is 4.' }] },
      }),
      '{ not json',
      JSON.stringify({ type: 'system', message: { content: 'ignored' } }),
      JSON.stringify({ type: 'user', message: { content: 'Thanks!' } }),
    ].join('\n');

    it('parses user/assistant turns and skips noise', () => {
      const turns = parseTranscript(transcript);
      expect(turns).toEqual([
        { role: 'user', text: 'What is 2+2?' },
        { role: 'assistant', text: 'It is 4.' },
        { role: 'user', text: 'Thanks!' },
      ]);
    });

    it('summarises a transcript file with the last assistant text', async () => {
      const tp = path.join(tempDir, 'transcript.jsonl');
      await fs.writeFile(tp, transcript);
      const s = await summarizeTranscript(tp);
      expect(s.turnCount).toBe(3);
      expect(s.lastAssistantText).toBe('It is 4.');
      expect(s.summary).toContain('User: What is 2+2?');
      expect(s.summary).toContain('Assistant: It is 4.');
    });

    it('returns empty summary for a missing transcript', async () => {
      const s = await summarizeTranscript(path.join(tempDir, 'missing.jsonl'));
      expect(s).toEqual({ summary: '', lastAssistantText: '', turnCount: 0 });
    });
  });

  describe('helpers', () => {
    it('builds continuation context mentioning the prior profile', () => {
      const ctx = buildContinuationContext({
        chain: 'default',
        threadId: 't',
        lastProfile: 'josh',
        summary: 'User: hi\nAssistant: hello',
        updatedAt: NOW.toISOString(),
      });
      expect(ctx).toContain('default');
      expect(ctx).toContain('josh');
      expect(ctx).toContain('User: hi');
      expect(ctx.toLowerCase()).toContain('continuing');
    });

    it('maps a config dir back to a profile name', () => {
      const profiles = {
        josh: { configDir: '/home/me/.claude-josh' },
        lockie: { configDir: '/home/me/.claude-lockie' },
      };
      expect(profileNameForConfigDir(profiles, '/home/me/.claude-lockie')).toBe(
        'lockie'
      );
      expect(profileNameForConfigDir(profiles, '/home/me/.claude-x')).toBeUndefined();
      expect(profileNameForConfigDir(profiles, undefined)).toBeUndefined();
    });

    it('generates a chain-prefixed thread id', () => {
      expect(newThreadId('default', NOW)).toMatch(/^default-/);
    });
  });
});
