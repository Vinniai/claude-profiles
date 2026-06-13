import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the profiles loader so the shortcut resolver doesn't touch disk.
vi.mock('../../src/lib/profiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/profiles.js')>();
  return {
    ...actual,
    loadProfiles: vi.fn(),
  };
});

import { expandProfileShortcut, createProgram } from '../../src/cli.js';
import { loadProfiles } from '../../src/lib/profiles.js';
import type { ProfileConfig } from '../../src/types/index.js';

const mockedLoad = vi.mocked(loadProfiles);

function cfg(): ProfileConfig {
  return {
    profiles: {
      josh: { alias: 'claude-josh', configDir: '/Users/mini/.claude-josh' },
      lockie: { alias: 'claude-lockie', configDir: '/Users/mini/.claude-lockie' },
    },
    chains: { default: ['josh', 'lockie'] },
  };
}

const NODE = '/usr/bin/node';
const SCRIPT = '/path/dist/index.js';

async function expand(args: string[]): Promise<string[]> {
  const program = createProgram();
  return expandProfileShortcut([NODE, SCRIPT, ...args], program);
}

describe('expandProfileShortcut', () => {
  beforeEach(() => {
    mockedLoad.mockReset();
    mockedLoad.mockResolvedValue(cfg());
  });

  it('rewrites a bare profile name to `run --profile <name> --`', async () => {
    const out = await expand(['josh', '-p', 'hi']);
    expect(out.slice(2)).toEqual(['run', '--profile', 'josh', '--', '-p', 'hi']);
  });

  it('rewrites a bare chain name to `run --chain <name> --`', async () => {
    const out = await expand(['default', '-p', 'hi']);
    expect(out.slice(2)).toEqual(['run', '--chain', 'default', '--', '-p', 'hi']);
  });

  it('forwards arbitrary claude flags after the inserted `--`', async () => {
    const out = await expand([
      'josh',
      '--dangerously-skip-permissions',
      '--model',
      'claude-sonnet-4-6',
      '-p',
      'hi',
    ]);
    expect(out.slice(2)).toEqual([
      'run',
      '--profile',
      'josh',
      '--',
      '--dangerously-skip-permissions',
      '--model',
      'claude-sonnet-4-6',
      '-p',
      'hi',
    ]);
  });

  it('leaves known subcommands untouched', async () => {
    const out = await expand(['chain', 'status']);
    expect(out.slice(2)).toEqual(['chain', 'status']);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('leaves a leading option untouched', async () => {
    const out = await expand(['--help']);
    expect(out.slice(2)).toEqual(['--help']);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('leaves an unknown name untouched (so commander reports it)', async () => {
    const out = await expand(['nope', '-p', 'hi']);
    expect(out.slice(2)).toEqual(['nope', '-p', 'hi']);
  });

  it('returns argv unchanged when no token is present', async () => {
    const out = await expand([]);
    expect(out).toEqual([NODE, SCRIPT]);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('prefers a profile over a chain on name collision', async () => {
    mockedLoad.mockResolvedValue({
      profiles: { default: { alias: 'claude-default', configDir: '/c/d' } },
      chains: { default: ['default'] },
    });
    const out = await expand(['default', '-p', 'hi']);
    expect(out.slice(2)).toEqual(['run', '--profile', 'default', '--', '-p', 'hi']);
  });

  it('survives a profiles-load failure by returning argv unchanged', async () => {
    mockedLoad.mockRejectedValue(new Error('boom'));
    const out = await expand(['josh', '-p', 'hi']);
    expect(out.slice(2)).toEqual(['josh', '-p', 'hi']);
  });

  it('collects two bare profiles into an ad-hoc --profiles chain', async () => {
    const out = await expand(['josh', 'lockie', '-p', 'hi']);
    expect(out.slice(2)).toEqual([
      'run',
      '--profiles',
      'josh,lockie',
      '--',
      '-p',
      'hi',
    ]);
  });

  it('carries inline weights into the --profiles spec', async () => {
    const out = await expand(['josh:3', 'lockie:1', '-p', 'hi']);
    expect(out.slice(2)).toEqual([
      'run',
      '--profiles',
      'josh:3,lockie:1',
      '--',
      '-p',
      'hi',
    ]);
  });

  it('keeps a run strategy flag in front of the -- separator', async () => {
    const out = await expand(['josh', 'lockie', '--balanced', '-p', 'hi']);
    expect(out.slice(2)).toEqual([
      'run',
      '--balanced',
      '--profiles',
      'josh,lockie',
      '--',
      '-p',
      'hi',
    ]);
  });

  it('keeps a value-bearing run flag (with its value) in front of --', async () => {
    const out = await expand(['josh', 'lockie', '--min-session', '20', '-p', 'hi']);
    expect(out.slice(2)).toEqual([
      'run',
      '--min-session',
      '20',
      '--profiles',
      'josh,lockie',
      '--',
      '-p',
      'hi',
    ]);
  });

  it('does not double the -- when the user already typed one', async () => {
    const out = await expand(['josh', 'lockie', '--', '-p', 'hi']);
    expect(out.slice(2)).toEqual([
      'run',
      '--profiles',
      'josh,lockie',
      '--',
      '-p',
      'hi',
    ]);
  });

  it('stops collecting at the first non-profile token', async () => {
    const out = await expand(['josh', 'notaprofile', '-p', 'hi']);
    expect(out.slice(2)).toEqual([
      'run',
      '--profile',
      'josh',
      '--',
      'notaprofile',
      '-p',
      'hi',
    ]);
  });

  it('keeps a run flag before -- for a lone chain name too', async () => {
    const out = await expand(['default', '--balanced', '-p', 'hi']);
    expect(out.slice(2)).toEqual([
      'run',
      '--balanced',
      '--chain',
      'default',
      '--',
      '-p',
      'hi',
    ]);
  });

  // Regression: `create`/`login` are now top-level commands. The shortcut
  // resolver must treat them as known subcommands and leave them alone — even
  // if a profile happens to be named `create` or `login` (the literal command
  // wins so you can always reach it).
  it('leaves the top-level `create` command untouched', async () => {
    const out = await expand(['create', 'alice']);
    expect(out.slice(2)).toEqual(['create', 'alice']);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('leaves the top-level `login` command untouched', async () => {
    const out = await expand(['login', 'alice']);
    expect(out.slice(2)).toEqual(['login', 'alice']);
    expect(mockedLoad).not.toHaveBeenCalled();
  });
});

describe('createProgram command registration', () => {
  it('registers root-level `create` and `login` shortcuts', () => {
    const names = createProgram().commands.map((c) => c.name());
    expect(names).toContain('create');
    expect(names).toContain('login');
    // The nested group is still present for `profile create/login` back-compat.
    expect(names).toContain('profile');
  });

  it('exposes `create`/`login` under the `profile` group as well', () => {
    const profile = createProgram().commands.find((c) => c.name() === 'profile');
    const sub = profile?.commands.map((c) => c.name()) ?? [];
    expect(sub).toContain('create');
    expect(sub).toContain('login');
  });
});
