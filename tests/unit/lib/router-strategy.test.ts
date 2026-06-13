import { describe, it, expect, vi, beforeEach } from 'vitest';

// Control loadState so buildCandidates is deterministic; keep the pure health
// helpers (isHealthy / cooldownRemainingMs) real.
vi.mock('../../../src/lib/state.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/lib/state.js')>();
  return { ...actual, loadState: vi.fn() };
});

import { buildCandidates, effectivePolicy } from '../../../src/lib/router.js';
import { loadState } from '../../../src/lib/state.js';
import type {
  ProfileConfig,
  RuntimeStateFile,
} from '../../../src/types/index.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const iso = (msFromNow: number) =>
  new Date(NOW.getTime() + msFromNow).toISOString();

function cfg(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    profiles: {
      a: { alias: 'claude-a', configDir: '/c/a', priority: 1 },
      b: { alias: 'claude-b', configDir: '/c/b', priority: 2 },
      c: { alias: 'claude-c', configDir: '/c/c', priority: 3 },
    },
    chains: { default: ['a', 'b', 'c'] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadState).mockResolvedValue({ profiles: {} } as RuntimeStateFile);
});

describe('effectivePolicy', () => {
  it('merges global → chain → profile (most specific wins)', () => {
    const config = cfg({
      routing: { policy: { minWeeklyRemaining: 10, minSessionRemaining: 10 } },
      chainRouting: { default: { policy: { minSessionRemaining: 30 } } },
    });
    config.profiles.a.policy = { minWeeklyRemaining: 50 };
    const p = effectivePolicy(config, 'default', 'a');
    expect(p).toEqual({ minWeeklyRemaining: 50, minSessionRemaining: 30 });
  });

  it('returns undefined when no policy applies', () => {
    expect(effectivePolicy(cfg(), 'default', 'a')).toBeUndefined();
  });
});

describe('buildCandidates — strategy', () => {
  it('defaults to priority order', async () => {
    const { candidates, strategy } = await buildCandidates(
      cfg(),
      { chain: 'default' },
      NOW
    );
    expect(strategy).toBe('priority');
    expect(candidates.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('round-robin puts the least-recently-used profile first', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        a: { lastUsedAt: iso(-1000) }, // used most recently
        b: { lastUsedAt: iso(-50_000) }, // used long ago → first
        // c never used → most eligible, ahead of both
      },
    } as RuntimeStateFile);
    const config = cfg({ routing: { strategy: 'round-robin' } });
    const { candidates, strategy } = await buildCandidates(
      config,
      { chain: 'default' },
      NOW
    );
    expect(strategy).toBe('round-robin');
    expect(candidates.map((c) => c.name)).toEqual(['c', 'b', 'a']);
  });

  it('most-remaining orders by highest session budget left', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        a: { usage: { session: { usedPct: 90 } } }, // 10% left
        b: { usage: { session: { usedPct: 20 } } }, // 80% left → first
        c: { usage: { session: { usedPct: 50 } } }, // 50% left
      },
    } as RuntimeStateFile);
    const config = cfg({ routing: { strategy: 'most-remaining' } });
    const { candidates } = await buildCandidates(
      config,
      { chain: 'default' },
      NOW
    );
    expect(candidates.map((c) => c.name)).toEqual(['b', 'c', 'a']);
  });

  it('per-chain strategy overrides the global default', async () => {
    const config = cfg({
      routing: { strategy: 'priority' },
      chainRouting: { default: { strategy: 'round-robin' } },
    });
    const { strategy } = await buildCandidates(
      config,
      { chain: 'default' },
      NOW
    );
    expect(strategy).toBe('round-robin');
  });
});

describe('buildCandidates — eligibility policy', () => {
  it('defers a healthy profile below its weekly floor and reports why', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        a: { usage: { weekly: { usedPct: 95 } } }, // 5% left < 50 floor → deferred
        b: { usage: { weekly: { usedPct: 10 } } }, // 90% left → eligible
      },
    } as RuntimeStateFile);
    const config = cfg({
      chains: { default: ['a', 'b'] },
      routing: { policy: { minWeeklyRemaining: 50 } },
    });
    const { candidates, deferred } = await buildCandidates(
      config,
      { chain: 'default' },
      NOW
    );
    // b (eligible) is tried before a (deferred), but a is never dropped.
    expect(candidates.map((c) => c.name)).toEqual(['b', 'a']);
    expect(deferred.map((d) => d.name)).toEqual(['a']);
    expect(deferred[0].reasons.join(' ')).toMatch(/weekly/i);
  });

  it('never drops everyone even if all fail the gate', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        a: { usage: { weekly: { usedPct: 99 } } },
        b: { usage: { weekly: { usedPct: 99 } } },
      },
    } as RuntimeStateFile);
    const config = cfg({
      chains: { default: ['a', 'b'] },
      routing: { policy: { minWeeklyRemaining: 50 } },
    });
    const { candidates, deferred } = await buildCandidates(
      config,
      { chain: 'default' },
      NOW
    );
    expect(candidates.map((c) => c.name).sort()).toEqual(['a', 'b']);
    expect(deferred).toHaveLength(2);
  });
});

describe('buildCandidates — health ordering', () => {
  it('keeps cooled-down profiles last, soonest-available first', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        a: { cooldownUntil: iso(60_000) }, // cooling 1m
        // b healthy
        c: { cooldownUntil: iso(10_000) }, // cooling 10s
      },
    } as RuntimeStateFile);
    const { candidates } = await buildCandidates(
      cfg(),
      { chain: 'default' },
      NOW
    );
    // healthy b first; then cooled by soonest availability: c (10s) before a (1m)
    expect(candidates.map((c) => c.name)).toEqual(['b', 'c', 'a']);
    expect(candidates[0].healthy).toBe(true);
  });
});

describe('buildCandidates — ad-hoc profiles + weights + overrides', () => {
  it('resolves an ad-hoc profile list in the order given', async () => {
    const { candidates } = await buildCandidates(
      cfg(),
      { profiles: ['c', 'a'] },
      NOW
    );
    expect(candidates.map((c) => c.name)).toEqual(['c', 'a']);
  });

  it('throws on an unknown ad-hoc profile', async () => {
    await expect(
      buildCandidates(cfg(), { profiles: ['a', 'ghost'] }, NOW)
    ).rejects.toThrow(/Unknown profile/);
  });

  it('strategyOverride beats the configured strategy', async () => {
    const config = cfg({ routing: { strategy: 'priority' } });
    const { strategy } = await buildCandidates(
      config,
      { chain: 'default', strategyOverride: 'round-robin' },
      NOW
    );
    expect(strategy).toBe('round-robin');
  });

  it('policyOverride defers a profile that fails the one-shot gate', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        a: { usage: { session: { usedPct: 95 } } }, // 5% left → deferred
        b: { usage: { session: { usedPct: 10 } } },
        c: { usage: { session: { usedPct: 10 } } },
      },
    } as RuntimeStateFile);
    const { candidates, deferred } = await buildCandidates(
      cfg(),
      { chain: 'default', policyOverride: { minSessionRemaining: 20 } },
      NOW
    );
    expect(deferred.map((d) => d.name)).toEqual(['a']);
    expect(candidates[candidates.length - 1].name).toBe('a');
  });
});

describe('buildCandidates — plan awareness', () => {
  function planned(): ProfileConfig {
    return {
      profiles: {
        pro: { alias: 'claude-pro', configDir: '/c/pro', plan: 'pro' },
        small: { alias: 'claude-small', configDir: '/c/small', plan: 'max-5x' },
        big: { alias: 'claude-big', configDir: '/c/big', plan: 'max-20x' },
      },
    };
  }

  it('orders by plan capacity (big-first) when no explicit priority/chain', async () => {
    const { candidates } = await buildCandidates(planned(), {}, NOW);
    expect(candidates.map((c) => c.name)).toEqual(['big', 'small', 'pro']);
  });

  it('weighted strategy uses plan capacity as the default weight', async () => {
    // rand() near 0 always picks the first slice; with capacities 20/5/1 the big
    // plan owns the largest slice and is selected first deterministically.
    const config = { ...planned(), routing: { strategy: 'weighted' as const } };
    const { candidates } = await buildCandidates(
      config,
      { profiles: ['pro', 'small', 'big'] },
      NOW
    );
    // weighted ordering is randomised, but every profile still appears once.
    expect(new Set(candidates.map((c) => c.name))).toEqual(
      new Set(['pro', 'small', 'big'])
    );
  });

  it('most-remaining scales percentage by plan capacity (absolute headroom)', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        // both 50% left, but big (20×) has more absolute runway than small (5×)
        small: { usage: { session: { usedPct: 50 } } },
        big: { usage: { session: { usedPct: 50 } } },
      },
    } as RuntimeStateFile);
    const config = {
      profiles: {
        small: { alias: 'claude-small', configDir: '/c/small', plan: 'max-5x' as const },
        big: { alias: 'claude-big', configDir: '/c/big', plan: 'max-20x' as const },
      },
      routing: { strategy: 'most-remaining' as const },
    };
    const { candidates } = await buildCandidates(
      config,
      { profiles: ['small', 'big'] },
      NOW
    );
    expect(candidates.map((c) => c.name)).toEqual(['big', 'small']);
  });
});

describe('buildCandidates — sticky session', () => {
  it('pins a healthy stickTo profile to the front, beating the strategy', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: {
        a: { lastUsedAt: iso(-1000) },
        b: { lastUsedAt: iso(-50_000) }, // round-robin would put b first
      },
    } as RuntimeStateFile);
    const config = cfg({ routing: { strategy: 'round-robin' } });
    const { candidates } = await buildCandidates(
      config,
      { chain: 'default', stickTo: 'a' },
      NOW
    );
    expect(candidates[0].name).toBe('a');
  });

  it('ignores stickTo when that profile is unhealthy (cooling down)', async () => {
    vi.mocked(loadState).mockResolvedValue({
      profiles: { a: { cooldownUntil: iso(60_000) } },
    } as RuntimeStateFile);
    const { candidates } = await buildCandidates(
      cfg(),
      { chain: 'default', stickTo: 'a' },
      NOW
    );
    // a is cooling, so it can't be pinned; a healthy profile leads instead.
    expect(candidates[0].name).not.toBe('a');
    expect(candidates[0].healthy).toBe(true);
  });
});
