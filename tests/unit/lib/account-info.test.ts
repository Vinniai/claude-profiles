import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { planFromOauth, readAccountInfo } from '../../../src/lib/account-info.js';

describe('planFromOauth', () => {
  it('maps the Max 20x rate-limit tier to max-20x', () => {
    expect(planFromOauth('claude_max', 'default_claude_max_20x')).toBe('max-20x');
  });

  it('maps the Max 5x rate-limit tier to max-5x', () => {
    expect(planFromOauth('claude_max', 'default_claude_max_5x')).toBe('max-5x');
  });

  it('maps a Pro org (default_claude_ai tier) to pro', () => {
    expect(planFromOauth('claude_pro', 'default_claude_ai')).toBe('pro');
  });

  it('falls back to max-5x for a Max org with an unreadable tier', () => {
    expect(planFromOauth('claude_max', undefined)).toBe('max-5x');
    expect(planFromOauth('claude_max', 'some_new_tier')).toBe('max-5x');
  });

  it('prefers the rate-limit tier over a coarse org type', () => {
    // Even if org type is vague, an explicit 20x tier wins.
    expect(planFromOauth(undefined, 'default_claude_max_20x')).toBe('max-20x');
  });

  it('returns undefined when nothing is recognizable', () => {
    expect(planFromOauth(undefined, undefined)).toBeUndefined();
    expect(planFromOauth('', '')).toBeUndefined();
  });
});

describe('readAccountInfo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-acct-'));
  });
  afterEach(async () => {
    await fs.remove(dir);
  });

  async function writeClaudeJson(obj: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify(obj));
  }

  it('extracts identity + plan from a Max 20x oauthAccount block', async () => {
    await writeClaudeJson({
      oauthAccount: {
        emailAddress: 'josh@tocld.com',
        displayName: 'Vinnie',
        organizationName: "josh@tocld.com's Organization",
        organizationType: 'claude_max',
        organizationRateLimitTier: 'default_claude_max_20x',
        userRateLimitTier: null,
        hasExtraUsageEnabled: true,
      },
    });
    const info = await readAccountInfo(dir);
    expect(info).toMatchObject({
      email: 'josh@tocld.com',
      displayName: 'Vinnie',
      organizationType: 'claude_max',
      rateLimitTier: 'default_claude_max_20x',
      hasExtraUsageEnabled: true,
      plan: 'max-20x',
    });
  });

  it('reads a Pro account as pro', async () => {
    await writeClaudeJson({
      oauthAccount: {
        emailAddress: 'p@example.com',
        organizationType: 'claude_pro',
        organizationRateLimitTier: 'default_claude_ai',
      },
    });
    const info = await readAccountInfo(dir);
    expect(info?.plan).toBe('pro');
    expect(info?.email).toBe('p@example.com');
  });

  it('prefers userRateLimitTier over the org tier when present', async () => {
    await writeClaudeJson({
      oauthAccount: {
        organizationType: 'claude_max',
        organizationRateLimitTier: 'default_claude_max_5x',
        userRateLimitTier: 'default_claude_max_20x',
      },
    });
    const info = await readAccountInfo(dir);
    expect(info?.rateLimitTier).toBe('default_claude_max_20x');
    expect(info?.plan).toBe('max-20x');
  });

  it('returns undefined when there is no oauthAccount block', async () => {
    await writeClaudeJson({ somethingElse: true });
    expect(await readAccountInfo(dir)).toBeUndefined();
  });

  it('returns undefined when the file is missing', async () => {
    expect(await readAccountInfo(path.join(dir, 'nope'))).toBeUndefined();
  });

  it('returns undefined on malformed JSON (never throws)', async () => {
    await fs.writeFile(path.join(dir, '.claude.json'), '{ not valid json');
    expect(await readAccountInfo(dir)).toBeUndefined();
  });
});
