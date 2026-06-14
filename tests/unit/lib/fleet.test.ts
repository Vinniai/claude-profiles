import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock spawn so captureWorker's timeout/escalation can be driven with fake timers.
// Only captureWorker touches spawn; every other test injects its own spawnImpl.
vi.mock('child_process', () => ({ spawn: vi.fn() }));

// Replace state writers with spies so the fleet never touches disk; mock
// loadProfiles so config-dir resolution is deterministic.
vi.mock('../../../src/lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/state.js')>();
  return {
    ...actual,
    setProfileCooldown: vi.fn(async () => {}),
    markNeedsAuth: vi.fn(async () => {}),
    markUsed: vi.fn(async () => {}),
  };
});
vi.mock('../../../src/lib/profiles.js', () => ({
  loadProfiles: vi.fn(async () => ({
    profiles: {
      josh: { alias: 'claude-josh', configDir: '/c/josh', plan: 'max-20x' },
      lockie: { alias: 'claude-lockie', configDir: '/c/lockie', plan: 'max-5x' },
    },
  })),
}));

import { spawn } from 'child_process';
import {
  workerArgs,
  workerEnv,
  parseEnvelope,
  runWorker,
  applyWorkerEffects,
  runFleet,
  captureWorker,
  type WorkerSpawn,
  type WorkerResult,
} from '../../../src/lib/fleet.js';
import { summarizeResult, taskFromArgs } from '../../../src/fleet/server.js';
import {
  mcpConfigJson,
  orchestratorExtraArgs,
  orchestratorSystemPrompt,
  remoteControlReadme,
  coordinatorArgs,
  selfInvocation,
} from '../../../src/fleet/orchestrator.js';
import { setProfileCooldown, markNeedsAuth, markUsed } from '../../../src/lib/state.js';

const NOW = new Date('2026-06-14T12:00:00.000Z');

/** A mock spawn that returns canned stdout/stderr/exit per config dir. */
function mockSpawn(map: Record<string, { exitCode: number; stdout: string; stderr?: string }>): WorkerSpawn {
  return async (configDir) => {
    const r = map[configDir];
    if (!r) throw new Error(`unexpected configDir ${configDir}`);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '' };
  };
}

function okEnvelope(text: string, id = 'sess-1'): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: id,
    total_cost_usd: 0.012,
    duration_ms: 4200,
    num_turns: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workerArgs', () => {
  it('builds a print-json invocation, never --bare', () => {
    expect(workerArgs({ profile: 'x', prompt: 'hi' })).toEqual(['-p', 'hi', '--output-format', 'json']);
  });
  it('appends model and resume when present', () => {
    expect(workerArgs({ profile: 'x', prompt: 'hi', model: 'claude-haiku-4-5-20251001', resume: 'sess-9' })).toEqual([
      '-p', 'hi', '--output-format', 'json', '--model', 'claude-haiku-4-5-20251001', '--resume', 'sess-9',
    ]);
  });
});

describe('workerArgs extras', () => {
  it('appends extraArgs last so a trailing variadic flag stays intact', () => {
    expect(
      workerArgs({ profile: 'x', prompt: 'hi', resume: 's', extraArgs: ['--allowedTools', 'a', 'b'] }),
    ).toEqual(['-p', 'hi', '--output-format', 'json', '--resume', 's', '--allowedTools', 'a', 'b']);
  });
});

describe('orchestrator helpers', () => {
  it('mcpConfigJson registers a stdio fleet server', () => {
    const cfg = JSON.parse(mcpConfigJson());
    expect(cfg.mcpServers.fleet.args).toContain('fleet');
    expect(cfg.mcpServers.fleet.args).toContain('--no-http');
  });
  it('selfInvocation honors CLAUDE_PROFILES_BIN override', () => {
    const prev = process.env.CLAUDE_PROFILES_BIN;
    process.env.CLAUDE_PROFILES_BIN = 'node /x/index.js';
    expect(selfInvocation()).toEqual({ command: 'node', args: ['/x/index.js'] });
    if (prev === undefined) delete process.env.CLAUDE_PROFILES_BIN;
    else process.env.CLAUDE_PROFILES_BIN = prev;
  });
  it('orchestratorExtraArgs wires the fleet tools and keeps allowedTools last', () => {
    const args = orchestratorExtraArgs('josh', '/tmp/fleet-mcp.json');
    expect(args.slice(0, 3)).toEqual(['--mcp-config', '/tmp/fleet-mcp.json', '--strict-mcp-config']);
    const at = args.indexOf('--allowedTools');
    expect(at).toBeGreaterThan(-1);
    expect(args.slice(at + 1)).toEqual([
      'mcp__fleet__delegate',
      'mcp__fleet__delegate_parallel',
      'mcp__fleet__fleet_status',
    ]);
  });
  it('orchestratorSystemPrompt names the lead and the tools', () => {
    const sp = orchestratorSystemPrompt('josh');
    expect(sp).toContain('josh');
    expect(sp).toContain('delegate_parallel');
  });
  it('coordinatorArgs (interactive) enables remote control + attaches fleet tools', () => {
    const args = coordinatorArgs({ lead: 'josh', name: 'Coord' }, '/tmp/fleet-mcp.json');
    expect(args[0]).toBe('--remote-control');
    expect(args).toContain('Coord');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/fleet-mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--append-system-prompt');
  });
  it('coordinatorArgs (server mode) uses the remote-control subcommand, no --mcp-config', () => {
    const args = coordinatorArgs({ lead: 'josh', name: 'Coord', server: true }, '/tmp/x.json');
    expect(args[0]).toBe('remote-control');
    expect(args).toEqual(['remote-control', '--name', 'Coord']);
    expect(args).not.toContain('--mcp-config');
  });
  it('remoteControlReadme shows the lead, port, and control endpoints', () => {
    const rm = remoteControlReadme('josh', 8798);
    expect(rm).toContain('josh');
    expect(rm).toContain('127.0.0.1:8798/control');
    expect(rm).toContain('/status');
    expect(rm).toContain('/reset');
  });
});

describe('workerEnv', () => {
  it('pins the config dir and scrubs API-key vars (subscription OAuth only)', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 'tok', PATH: '/bin' };
    const env = workerEnv('/c/josh', base);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c/josh');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });
});

describe('parseEnvelope', () => {
  it('extracts the result object', () => {
    const e = parseEnvelope(okEnvelope('done'));
    expect(e?.result).toBe('done');
    expect(e?.session_id).toBe('sess-1');
    expect(e?.total_cost_usd).toBe(0.012);
  });
  it('takes the last element of an array envelope', () => {
    const e = parseEnvelope(JSON.stringify([{ type: 'system' }, { result: 'last', session_id: 's' }]));
    expect(e?.result).toBe('last');
  });
  it('returns null for non-JSON output', () => {
    expect(parseEnvelope('plain text')).toBeNull();
    expect(parseEnvelope('')).toBeNull();
  });
});

describe('runWorker', () => {
  it('returns a success result parsed from the envelope', async () => {
    const r = await runWorker(
      { profile: 'josh', prompt: 'hi' },
      '/c/josh',
      { spawnImpl: mockSpawn({ '/c/josh': { exitCode: 0, stdout: okEnvelope('the answer') } }), now: NOW },
    );
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('none');
    expect(r.text).toBe('the answer');
    expect(r.sessionId).toBe('sess-1');
    expect(r.costUsd).toBe(0.012);
  });

  it('classifies a rate-limit failure', async () => {
    const r = await runWorker(
      { profile: 'josh', prompt: 'hi' },
      '/c/josh',
      {
        spawnImpl: mockSpawn({
          '/c/josh': { exitCode: 1, stdout: JSON.stringify({ is_error: true, result: 'usage limit reached' }) },
        }),
        now: NOW,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('rate_limit');
    expect(r.text).toBe('');
  });

  it('captures a spawn error without throwing', async () => {
    const r = await runWorker(
      { profile: 'josh', prompt: 'hi' },
      '/c/josh',
      { spawnImpl: async () => { throw new Error('ENOENT claude'); }, now: NOW },
    );
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('other');
    expect(r.error).toContain('ENOENT');
  });
});

describe('applyWorkerEffects', () => {
  function result(over: Partial<WorkerResult>): WorkerResult {
    return {
      profile: 'josh', ok: false, kind: 'other', text: '',
      outcome: { ok: false, kind: 'other', resetAt: null, reason: 'x', raw: '' },
      ...over,
    };
  }
  it('stamps last-used on success', async () => {
    await applyWorkerEffects(result({ ok: true, kind: 'none' }), NOW);
    expect(markUsed).toHaveBeenCalledWith('josh', NOW);
    expect(setProfileCooldown).not.toHaveBeenCalled();
  });
  it('cools down on rate-limit using the parsed reset time', async () => {
    const resetAt = new Date(NOW.getTime() + 3600_000);
    await applyWorkerEffects(
      result({ kind: 'rate_limit', outcome: { ok: false, kind: 'rate_limit', resetAt, reason: 'limit', raw: '' } }),
      NOW,
    );
    expect(setProfileCooldown).toHaveBeenCalledWith('josh', resetAt, 'limit', NOW);
  });
  it('flags needs-auth on an auth failure', async () => {
    await applyWorkerEffects(
      result({ kind: 'auth', outcome: { ok: false, kind: 'auth', resetAt: null, reason: 'expired', raw: '' } }),
      NOW,
    );
    expect(markNeedsAuth).toHaveBeenCalledWith('josh', 'expired');
  });
  it('does nothing for a generic failure', async () => {
    await applyWorkerEffects(result({ kind: 'other' }), NOW);
    expect(setProfileCooldown).not.toHaveBeenCalled();
    expect(markNeedsAuth).not.toHaveBeenCalled();
    expect(markUsed).not.toHaveBeenCalled();
  });
});

describe('runFleet', () => {
  it('runs tasks across profiles and preserves input order', async () => {
    const results = await runFleet(
      [
        { profile: 'josh', prompt: 'a' },
        { profile: 'lockie', prompt: 'b' },
      ],
      {
        spawnImpl: mockSpawn({
          '/c/josh': { exitCode: 0, stdout: okEnvelope('from josh', 'j') },
          '/c/lockie': { exitCode: 0, stdout: okEnvelope('from lockie', 'l') },
        }),
        now: NOW,
      },
    );
    expect(results.map((r) => r.profile)).toEqual(['josh', 'lockie']);
    expect(results[0].text).toBe('from josh');
    expect(results[1].text).toBe('from lockie');
    expect(markUsed).toHaveBeenCalledTimes(2);
  });

  it('skips state effects when recordEffects is false', async () => {
    await runFleet(
      [{ profile: 'josh', prompt: 'a' }],
      {
        recordEffects: false,
        spawnImpl: mockSpawn({ '/c/josh': { exitCode: 0, stdout: okEnvelope('x') } }),
        now: NOW,
      },
    );
    expect(markUsed).not.toHaveBeenCalled();
  });

  it('isolates an unknown profile to its own slot instead of failing the batch', async () => {
    const results = await runFleet(
      [
        { profile: 'josh', prompt: 'a' },
        { profile: 'ghost', prompt: 'b' },
      ],
      {
        spawnImpl: mockSpawn({ '/c/josh': { exitCode: 0, stdout: okEnvelope('from josh', 'j') } }),
        now: NOW,
      },
    );
    expect(results.map((r) => r.profile)).toEqual(['josh', 'ghost']);
    expect(results[0].ok).toBe(true);
    expect(results[0].text).toBe('from josh');
    expect(results[1].ok).toBe(false);
    expect(results[1].kind).toBe('other');
    expect(results[1].outcome.reason).toBe('unknown profile');
    expect(markUsed).toHaveBeenCalledTimes(1); // only the valid task is stamped
  });
});

describe('captureWorker timeout escalation', () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stdout: { on: ReturnType<typeof vi.fn> };
      stderr: { on: ReturnType<typeof vi.fn> };
    };
    child.kill = vi.fn();
    child.stdout = { on: vi.fn() };
    child.stderr = { on: vi.fn() };
    return child;
  }

  it('sends SIGTERM at the timeout then escalates to SIGKILL after the grace window', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      vi.mocked(spawn).mockReturnValue(child as never);
      const promise = captureWorker('/c/josh', ['-p', 'hi'], 1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(2000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      child.emit('close', null);
      const result = await promise;
      expect(result.stderr).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the escalation timer on a clean close (never force-kills)', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      vi.mocked(spawn).mockReturnValue(child as never);
      const promise = captureWorker('/c/josh', ['-p', 'hi'], 1000);

      child.emit('close', 0);
      await promise;

      await vi.advanceTimersByTimeAsync(5000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('server helpers', () => {
  it('summarizeResult keeps actionable fields and drops bulky raw', () => {
    const s = summarizeResult({
      profile: 'josh', ok: true, kind: 'none', text: 'hi', sessionId: 's', costUsd: 0.01,
      outcome: { ok: true, kind: 'none', resetAt: null, reason: 'ok', raw: 'lots of text' },
    });
    expect(s).toMatchObject({ profile: 'josh', ok: true, text: 'hi', sessionId: 's' });
    expect(s).not.toHaveProperty('outcome');
    expect(s).not.toHaveProperty('reason'); // success → no reason
  });
  it('summarizeResult surfaces reason + error on failure', () => {
    const s = summarizeResult({
      profile: 'josh', ok: false, kind: 'other', text: '', error: 'boom',
      outcome: { ok: false, kind: 'other', resetAt: null, reason: 'command failed', raw: '' },
    });
    expect(s).toMatchObject({ ok: false, reason: 'command failed', error: 'boom' });
  });
  it('taskFromArgs validates required fields', () => {
    expect(taskFromArgs({ profile: 'josh', prompt: 'hi', model: 'm' })).toEqual({
      profile: 'josh', prompt: 'hi', model: 'm', resume: undefined, timeoutMs: undefined,
    });
    expect(taskFromArgs({ profile: 'josh' })).toBeNull();
    expect(taskFromArgs({ prompt: 'hi' })).toBeNull();
  });
});
