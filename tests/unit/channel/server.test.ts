import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config + persistence so requestSwitch is deterministic; keep the pure
// health helpers (isHealthy / cooldownRemainingMs) and profileNameForConfigDir real.
vi.mock('../../../src/lib/profiles.js', () => ({ loadProfiles: vi.fn() }));
vi.mock('../../../src/lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/state.js')>();
  return { ...actual, loadState: vi.fn(), setProfileCooldown: vi.fn() };
});
vi.mock('../../../src/lib/handoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/handoff.js')>();
  return { ...actual, updateHandoff: vi.fn() };
});

import {
  resolveCurrentContext,
  formatStateEvent,
  diffStates,
  planSwitch,
  requestSwitch,
} from '../../../src/channel/server.js';
import { loadProfiles } from '../../../src/lib/profiles.js';
import { loadState, setProfileCooldown } from '../../../src/lib/state.js';
import type {
  ProfileConfig,
  RuntimeStateFile,
} from '../../../src/types/index.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();

function config(): ProfileConfig {
  return {
    profiles: {
      a: { alias: 'claude-a', configDir: '/c/a' },
      b: { alias: 'claude-b', configDir: '/c/b' },
      c: { alias: 'claude-c', configDir: '/c/c' },
    },
    chains: { default: ['a', 'b', 'c'] },
  };
}

describe('resolveCurrentContext', () => {
  it('maps CLAUDE_CONFIG_DIR to a profile and reads chain/thread', () => {
    const ctx = resolveCurrentContext(
      {
        CLAUDE_CONFIG_DIR: '/c/b',
        CLAUDE_PROFILES_CHAIN: 'default',
        CLAUDE_PROFILES_THREAD: 'default-abc',
      } as NodeJS.ProcessEnv,
      config()
    );
    expect(ctx).toEqual({
      profile: 'b',
      chain: 'default',
      threadId: 'default-abc',
      configDir: '/c/b',
    });
  });

  it('returns nulls when nothing is set', () => {
    const ctx = resolveCurrentContext({} as NodeJS.ProcessEnv, config());
    expect(ctx).toEqual({ profile: null, chain: null, threadId: null, configDir: null });
  });
});

describe('formatStateEvent', () => {
  it('emits a "limit" event with reset time when a profile cools down', () => {
    const e = formatStateEvent('a', {}, { cooldownUntil: iso(90 * 60_000) }, NOW);
    expect(e?.meta.event).toBe('limit');
    expect(e?.meta.profile).toBe('a');
    expect(e?.meta.resets_in).toBe('1h30m');
    expect(e?.content).toMatch(/cooling down/i);
  });

  it('emits "needs_auth" when a profile is flagged for re-login', () => {
    const e = formatStateEvent('a', {}, { needsAuth: true, lastError: 'token expired' }, NOW);
    expect(e?.meta.event).toBe('needs_auth');
    expect(e?.content).toMatch(/token expired/);
  });

  it('emits "recovered" when a cooled profile becomes healthy', () => {
    // prev is unhealthy (cooldown still in the future), next has it cleared.
    const e = formatStateEvent('a', { cooldownUntil: iso(60_000) }, {}, NOW);
    expect(e?.meta.event).toBe('recovered');
  });

  it('returns null when health is unchanged (e.g. only usage updated)', () => {
    const prev = { usage: { session: { usedPct: 10 } } };
    const next = { usage: { session: { usedPct: 40 } } };
    expect(formatStateEvent('a', prev, next, NOW)).toBeNull();
  });
});

describe('diffStates', () => {
  it('reports one event per profile that changed health', () => {
    const prev: RuntimeStateFile = { profiles: { a: {}, b: { cooldownUntil: iso(60_000) } } };
    const next: RuntimeStateFile = {
      profiles: { a: { cooldownUntil: iso(60_000) }, b: {} },
    };
    const events = diffStates(prev, next, NOW);
    const byProfile = Object.fromEntries(events.map((e) => [e.meta.profile, e.meta.event]));
    expect(byProfile).toEqual({ a: 'limit', b: 'recovered' });
  });
});

describe('planSwitch', () => {
  const names = ['a', 'b', 'c'];
  const healthy: RuntimeStateFile = { profiles: {} };

  it('with no target cools only the current and resumes on the next healthy', () => {
    const plan = planSwitch({ chainNames: names, current: 'a', state: healthy, now: NOW });
    expect(plan.cooldown).toEqual(['a']);
    expect(plan.next).toBe('b');
  });

  it('skips a cooled-down successor when choosing the next account', () => {
    const state: RuntimeStateFile = { profiles: { b: { cooldownUntil: iso(60_000) } } };
    const plan = planSwitch({ chainNames: names, current: 'a', state, now: NOW });
    expect(plan.cooldown).toEqual(['a']);
    expect(plan.next).toBe('c');
  });

  it('cools every account ahead of an explicit target so it lands exactly there', () => {
    const plan = planSwitch({ chainNames: names, current: 'a', target: 'c', state: healthy, now: NOW });
    expect(plan.cooldown).toEqual(['a', 'b']);
    expect(plan.next).toBe('c');
  });

  it('cools only current when the target is not ahead in the chain', () => {
    const plan = planSwitch({ chainNames: names, current: 'b', target: 'a', state: healthy, now: NOW });
    expect(plan.cooldown).toEqual(['b']);
    expect(plan.note).toMatch(/not ahead/i);
  });

  it('cools current with no successor when there is no chain context', () => {
    const plan = planSwitch({ chainNames: [], current: 'a', state: healthy, now: NOW });
    expect(plan.cooldown).toEqual(['a']);
    expect(plan.next).toBeNull();
  });

  it('does nothing when no current profile is resolved', () => {
    const plan = planSwitch({ chainNames: names, current: null, state: healthy, now: NOW });
    expect(plan.cooldown).toEqual([]);
  });
});

describe('requestSwitch (integration with state writes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadProfiles).mockResolvedValue(config());
    vi.mocked(loadState).mockResolvedValue({ profiles: {} });
  });

  it('writes a cooldown for each planned profile when choosing a target', async () => {
    const result = await requestSwitch({
      target: 'c',
      minutes: 30,
      env: { CLAUDE_CONFIG_DIR: '/c/a', CLAUDE_PROFILES_CHAIN: 'default' } as NodeJS.ProcessEnv,
      now: NOW,
    });

    expect(result.applied).toBe(true);
    expect(result.cooldown).toEqual(['a', 'b']);
    expect(result.next).toBe('c');

    const cooled = vi.mocked(setProfileCooldown).mock.calls.map((c) => c[0]);
    expect(cooled).toEqual(['a', 'b']);
    // Cooldown horizon = now + 30 min.
    const until = vi.mocked(setProfileCooldown).mock.calls[0][1] as Date;
    expect(until.toISOString()).toBe(iso(30 * 60_000));
  });

  it('cools just the current account with no target', async () => {
    const result = await requestSwitch({
      env: { CLAUDE_CONFIG_DIR: '/c/a', CLAUDE_PROFILES_CHAIN: 'default' } as NodeJS.ProcessEnv,
      now: NOW,
    });
    expect(result.cooldown).toEqual(['a']);
    expect(vi.mocked(setProfileCooldown)).toHaveBeenCalledTimes(1);
  });
});
