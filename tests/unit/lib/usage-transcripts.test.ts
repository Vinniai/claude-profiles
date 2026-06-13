import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  scanTranscriptUsage,
  estimateCostUsd,
  pricingForModel,
  DEFAULT_PRICING,
} from '../../../src/lib/usage-transcripts.js';

const NOW = new Date('2026-06-13T12:00:00.000Z');

/** Build one assistant transcript line with a usage block at a given age. */
function assistantLine(opts: {
  ageMinutes: number;
  model?: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}): string {
  const ts = new Date(NOW.getTime() - opts.ageMinutes * 60_000).toISOString();
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-opus-4-8',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  });
}

describe('scanTranscriptUsage', () => {
  let configDir: string;
  let projDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-tx-'));
    projDir = path.join(configDir, 'projects', '-some-project');
    await fs.ensureDir(projDir);
  });
  afterEach(async () => {
    await fs.remove(configDir);
  });

  async function writeTranscript(name: string, lines: string[]): Promise<void> {
    await fs.writeFile(path.join(projDir, name), lines.join('\n') + '\n');
  }

  it('returns zeroed totals when there is no projects dir', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-empty-'));
    const u = await scanTranscriptUsage(empty, { now: NOW });
    expect(u.session.totalTokens).toBe(0);
    expect(u.weekly.totalTokens).toBe(0);
    expect(u.lastActivityAt).toBeUndefined();
    await fs.remove(empty);
  });

  it('sums token components and buckets into session + weekly windows', async () => {
    await writeTranscript('s.jsonl', [
      // 1h ago → inside the 5h session window (and the 7d week)
      assistantLine({ ageMinutes: 60, input: 100, output: 50, cacheRead: 1000 }),
      // 3 days ago → weekly only
      assistantLine({ ageMinutes: 3 * 24 * 60, input: 10, output: 5 }),
    ]);
    const u = await scanTranscriptUsage(configDir, { now: NOW });

    // session: only the 1h-ago turn
    expect(u.session.inputTokens).toBe(100);
    expect(u.session.outputTokens).toBe(50);
    expect(u.session.cacheReadTokens).toBe(1000);
    expect(u.session.totalTokens).toBe(1150);
    expect(u.session.messages).toBe(1);

    // weekly: both turns
    expect(u.weekly.inputTokens).toBe(110);
    expect(u.weekly.outputTokens).toBe(55);
    expect(u.weekly.totalTokens).toBe(1165);
    expect(u.weekly.messages).toBe(2);
  });

  it('excludes turns older than the weekly window', async () => {
    await writeTranscript('old.jsonl', [
      assistantLine({ ageMinutes: 10 * 24 * 60, input: 999, output: 999 }), // 10d ago
    ]);
    const u = await scanTranscriptUsage(configDir, { now: NOW });
    expect(u.weekly.totalTokens).toBe(0);
    expect(u.weekly.messages).toBe(0);
  });

  it('tracks per-model token totals and last activity', async () => {
    await writeTranscript('m.jsonl', [
      assistantLine({ ageMinutes: 30, model: 'claude-opus-4-8', input: 100, output: 100 }),
      assistantLine({ ageMinutes: 45, model: 'claude-sonnet-4-6', input: 10, output: 10 }),
    ]);
    const u = await scanTranscriptUsage(configDir, { now: NOW });
    expect(u.session.byModel['claude-opus-4-8']).toBe(200);
    expect(u.session.byModel['claude-sonnet-4-6']).toBe(20);
    // last activity is the most recent (30m ago) turn
    expect(u.lastActivityAt).toBe(new Date(NOW.getTime() - 30 * 60_000).toISOString());
  });

  it('honors custom window sizes', async () => {
    await writeTranscript('w.jsonl', [
      assistantLine({ ageMinutes: 90, input: 100, output: 100 }), // 1.5h ago
    ]);
    // 1h session window → the 1.5h-ago turn falls outside it
    const u = await scanTranscriptUsage(configDir, {
      now: NOW,
      sessionWindowMs: 60 * 60_000,
    });
    expect(u.session.messages).toBe(0);
    expect(u.weekly.messages).toBe(1);
  });

  it('ignores non-assistant lines and malformed JSON', async () => {
    await writeTranscript('mixed.jsonl', [
      JSON.stringify({ type: 'user', timestamp: NOW.toISOString(), message: { role: 'user' } }),
      '{ broken json',
      'summary line without usage',
      assistantLine({ ageMinutes: 10, input: 7, output: 3 }),
    ]);
    const u = await scanTranscriptUsage(configDir, { now: NOW });
    expect(u.session.messages).toBe(1);
    expect(u.session.totalTokens).toBe(10);
  });
});

describe('cost estimation', () => {
  it('prices opus higher than sonnet higher than haiku', () => {
    expect(pricingForModel('claude-opus-4-8').output).toBeGreaterThan(
      pricingForModel('claude-sonnet-4-6').output
    );
    expect(pricingForModel('claude-sonnet-4-6').output).toBeGreaterThan(
      pricingForModel('claude-haiku-4-5').output
    );
  });

  it('falls back to default pricing for unknown models', () => {
    expect(pricingForModel('some-future-model')).toEqual(DEFAULT_PRICING);
  });

  it('estimates zero cost for empty totals', () => {
    expect(
      estimateCostUsd({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        messages: 0,
        byModel: {},
      })
    ).toBe(0);
  });

  it('computes a positive cost weighted by component', () => {
    // 1M output tokens on opus = $75 by list price.
    const cost = estimateCostUsd({
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 1_000_000,
      messages: 1,
      byModel: { 'claude-opus-4-8': 1_000_000 },
    });
    expect(cost).toBeCloseTo(75, 1);
  });
});
