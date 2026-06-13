import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace only the state *writers* with spies so the router never touches disk;
// keep the pure helpers (isHealthy / cooldownRemainingMs) real.
vi.mock('../../../src/lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/state.js')>();
  return {
    ...actual,
    setProfileCooldown: vi.fn(async () => {}),
    markNeedsAuth: vi.fn(async () => {}),
  };
});

import {
  resolveProfileNames,
  orderCandidates,
  runWithFallback,
  runInteractiveWithFailover,
  type Candidate,
} from '../../../src/lib/router.js';
import { setProfileCooldown, markNeedsAuth } from '../../../src/lib/state.js';
import type {
  ProfileConfig,
  RuntimeStateFile,
} from '../../../src/types/index.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

function cfg(): ProfileConfig {
  return {
    profiles: {
      a: { alias: 'claude-a', configDir: '/c/a', priority: 1 },
      b: { alias: 'claude-b', configDir: '/c/b', priority: 2 },
      c: { alias: 'claude-c', configDir: '/c/c' },
    },
    chains: { default: ['a', 'b'], work: ['b', 'c'] },
  };
}

function candidate(name: string, healthy = true): Candidate {
  return {
    name,
    profile: { alias: `claude-${name}`, configDir: `/c/${name}` },
    healthy,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveProfileNames', () => {
  it('returns a single profile when --profile is given', () => {
    expect(resolveProfileNames(cfg(), { profile: 'b' })).toEqual(['b']);
  });

  it('throws for an unknown --profile', () => {
    expect(() => resolveProfileNames(cfg(), { profile: 'nope' })).toThrow();
  });

  it('returns the named chain order', () => {
    expect(resolveProfileNames(cfg(), { chain: 'work' })).toEqual(['b', 'c']);
  });

  it('throws for an unknown chain', () => {
    expect(() => resolveProfileNames(cfg(), { chain: 'ghost' })).toThrow();
  });

  it('prefers the "default" chain when nothing is specified', () => {
    expect(resolveProfileNames(cfg(), {})).toEqual(['a', 'b']);
  });

  it('falls back to all profiles by ascending priority when no default chain', () => {
    const c = cfg();
    delete c.chains!.default;
    // a(1), b(2), c(undefined -> last)
    expect(resolveProfileNames(c, {})).toEqual(['a', 'b', 'c']);
  });
});

describe('orderCandidates', () => {
  it('puts healthy profiles first, then cooled by soonest availability', () => {
    const state: RuntimeStateFile = {
      profiles: {
        a: { cooldownUntil: new Date(NOW.getTime() + 60_000).toISOString() }, // 1m
        b: {}, // healthy
        c: { cooldownUntil: new Date(NOW.getTime() + 10_000).toISOString() }, // 10s
      },
    };
    const ordered = orderCandidates(['a', 'b', 'c'], cfg(), state, NOW);
    expect(ordered.map((o) => o.name)).toEqual(['b', 'c', 'a']);
    expect(ordered[0].healthy).toBe(true);
  });

  it('treats needsAuth as unhealthy', () => {
    const state: RuntimeStateFile = { profiles: { a: { needsAuth: true } } };
    const ordered = orderCandidates(['a', 'b'], cfg(), state, NOW);
    expect(ordered.map((o) => o.name)).toEqual(['b', 'a']);
  });
});

describe('runWithFallback', () => {
  it('falls over from a rate-limited profile to the next and records a cooldown', async () => {
    const calls: string[] = [];
    const spawnImpl = vi.fn(async (configDir: string) => {
      calls.push(configDir);
      if (configDir === '/c/a') {
        return { exitCode: 1, stdout: '', stderr: 'usage limit reached' };
      }
      return { exitCode: 0, stdout: 'hello from b', stderr: '' };
    });

    const result = await runWithFallback({
      candidates: [candidate('a'), candidate('b')],
      claudeArgs: ['-p', 'hi'],
      spawnImpl,
      now: () => NOW,
    });

    expect(calls).toEqual(['/c/a', '/c/b']);
    expect(result.succeeded).toBe('b');
    expect(result.stdout).toBe('hello from b');
    expect(setProfileCooldown).toHaveBeenCalledOnce();
    expect(vi.mocked(setProfileCooldown).mock.calls[0][0]).toBe('a');
  });

  it('marks needsAuth (not cooldown) for an auth failure', async () => {
    const spawnImpl = vi.fn(async (configDir: string) => {
      if (configDir === '/c/a') {
        return { exitCode: 1, stdout: '', stderr: '401 unauthorized' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    const result = await runWithFallback({
      candidates: [candidate('a'), candidate('b')],
      claudeArgs: [],
      spawnImpl,
      now: () => NOW,
    });
    expect(result.succeeded).toBe('b');
    expect(markNeedsAuth).toHaveBeenCalledOnce();
    expect(setProfileCooldown).not.toHaveBeenCalled();
  });

  it('surfaces a non-failover error immediately without trying the next', async () => {
    const spawnImpl = vi.fn(async () => ({
      exitCode: 3,
      stdout: '',
      stderr: 'TypeError: boom',
    }));
    const result = await runWithFallback({
      candidates: [candidate('a'), candidate('b')],
      claudeArgs: [],
      spawnImpl,
      now: () => NOW,
    });
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(result.succeeded).toBeNull();
    expect(result.exitCode).toBe(3);
  });

  it('throws ALL_PROFILES_EXHAUSTED when every candidate is rate limited', async () => {
    const spawnImpl = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'usage limit reached',
    }));
    await expect(
      runWithFallback({
        candidates: [candidate('a'), candidate('b')],
        claudeArgs: [],
        spawnImpl,
        now: () => NOW,
      })
    ).rejects.toMatchObject({ code: 'ALL_PROFILES_EXHAUSTED' });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });
});

describe('runInteractiveWithFailover', () => {
  it('relaunches the next healthy profile when the active one is throttled', async () => {
    const launched: string[] = [];
    // "a" gets throttled during its session, "b" exits clean.
    const cooled = new Set(['a']);
    const result = await runInteractiveWithFailover({
      candidates: [candidate('a'), candidate('b')],
      claudeArgs: [],
      chain: 'default',
      threadId: 'default-1',
      spawnInteractive: async (c) => {
        launched.push(c.name);
        return 0;
      },
      isCooledDown: async (name) => cooled.has(name),
      now: () => NOW,
    });
    expect(launched).toEqual(['a', 'b']);
    expect(result.lastProfile).toBe('b');
    expect(result.path).toEqual(['a', 'b']);
  });

  it('stops after a clean session (active profile still healthy)', async () => {
    const launched: string[] = [];
    const result = await runInteractiveWithFailover({
      candidates: [candidate('a'), candidate('b')],
      claudeArgs: [],
      spawnInteractive: async (c) => {
        launched.push(c.name);
        return 0;
      },
      isCooledDown: async () => false,
      now: () => NOW,
    });
    expect(launched).toEqual(['a']);
    expect(result.lastProfile).toBe('a');
  });

  it('does not relaunch when no untried healthy candidate remains', async () => {
    const launched: string[] = [];
    const result = await runInteractiveWithFailover({
      candidates: [candidate('a'), candidate('b', false)], // b already unhealthy
      claudeArgs: [],
      spawnInteractive: async (c) => {
        launched.push(c.name);
        return 7;
      },
      isCooledDown: async () => true, // a got throttled too
      now: () => NOW,
    });
    expect(launched).toEqual(['a']);
    expect(result.exitCode).toBe(7);
  });

  it('passes the chain + thread env into the spawned child', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    await runInteractiveWithFailover({
      candidates: [candidate('a')],
      claudeArgs: [],
      chain: 'default',
      threadId: 'default-9',
      spawnInteractive: async (_c, _args, env) => {
        capturedEnv = env;
        return 0;
      },
      isCooledDown: async () => false,
      now: () => NOW,
    });
    expect(capturedEnv?.CLAUDE_PROFILES_CHAIN).toBe('default');
    expect(capturedEnv?.CLAUDE_PROFILES_THREAD).toBe('default-9');
    expect(capturedEnv?.CLAUDE_PROFILES_RUN).toBe('1');
  });
});
