import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// Mock paths so the chain registry + aliases land inside a temp dir.
vi.mock('../../../src/lib/paths.js', () => ({
  getConfigPaths: vi.fn(),
  getClaudeProfilesDir: vi.fn(),
}));

import {
  saveProfiles,
  createChain,
  deleteChain,
  addToChain,
  removeFromChain,
  getChain,
  listChains,
  getChainAliasLine,
  getChainAliasBlock,
  installChainAlias,
  removeChainAlias,
  installShellAlias,
} from '../../../src/lib/profiles.js';
import {
  getConfigPaths,
  getClaudeProfilesDir,
} from '../../../src/lib/paths.js';
import type { Profile } from '../../../src/types/index.js';

describe('chain management', () => {
  let tempDir: string;
  let claudeConfigDir: string;
  let claudeProfilesDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-profiles-chain-'));
    claudeConfigDir = path.join(tempDir, '.claude');
    claudeProfilesDir = path.join(tempDir, '.claude-profiles');
    await fs.ensureDir(claudeConfigDir);
    await fs.ensureDir(claudeProfilesDir);

    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    vi.mocked(getConfigPaths).mockReturnValue({
      claudeConfigDir,
      claudeProfilesDir,
      platform: 'darwin',
    });
    vi.mocked(getClaudeProfilesDir).mockReturnValue(claudeProfilesDir);

    // Seed three profiles the chains can reference.
    const profile = (name: string): Profile => ({
      alias: `claude-${name}`,
      configDir: path.join(tempDir, `.claude-${name}`),
    });
    await saveProfiles({
      profiles: {
        a: profile('a'),
        b: profile('b'),
        c: profile('c'),
      },
    });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  describe('CRUD', () => {
    it('creates a chain in fallback order', async () => {
      const created = await createChain('default', ['a', 'b', 'c']);
      expect(created).toEqual(['a', 'b', 'c']);
      expect(await getChain('default')).toEqual(['a', 'b', 'c']);
    });

    it('rejects a chain referencing an unknown profile', async () => {
      await expect(createChain('bad', ['a', 'ghost'])).rejects.toMatchObject({
        message: expect.stringContaining('ghost'),
      });
    });

    it('rejects an empty chain', async () => {
      await expect(createChain('empty', [])).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
      });
    });

    it('appends without duplicating', async () => {
      await createChain('default', ['a']);
      expect(await addToChain('default', 'b')).toEqual(['a', 'b']);
      // adding 'b' again is a no-op
      expect(await addToChain('default', 'b')).toEqual(['a', 'b']);
    });

    it('addToChain rejects unknown profiles', async () => {
      await createChain('default', ['a']);
      await expect(addToChain('default', 'ghost')).rejects.toMatchObject({
        message: expect.stringContaining('ghost'),
      });
    });

    it('removes a profile from a chain', async () => {
      await createChain('default', ['a', 'b', 'c']);
      expect(await removeFromChain('default', 'b')).toEqual(['a', 'c']);
    });

    it('removeFromChain throws for an unknown chain', async () => {
      await expect(removeFromChain('ghost', 'a')).rejects.toMatchObject({
        code: 'NO_CHAIN',
      });
    });

    it('refuses to empty a chain by removing its last profile', async () => {
      await createChain('solo', ['a']);
      // Removing the only member would leave an empty (useless) chain — guard it.
      await expect(removeFromChain('solo', 'a')).rejects.toMatchObject({
        code: 'NO_CHAIN',
      });
      // The chain is left intact, not silently emptied.
      expect(await getChain('solo')).toEqual(['a']);
    });

    it('deletes a chain', async () => {
      await createChain('default', ['a', 'b']);
      await deleteChain('default');
      expect(await getChain('default')).toBeUndefined();
    });

    it('deleteChain throws for an unknown chain', async () => {
      await expect(deleteChain('ghost')).rejects.toMatchObject({
        code: 'NO_CHAIN',
      });
    });

    it('lists all chains', async () => {
      await createChain('default', ['a', 'b']);
      await createChain('work', ['b', 'c']);
      expect(await listChains()).toEqual({
        default: ['a', 'b'],
        work: ['b', 'c'],
      });
    });
  });

  describe('alias generation', () => {
    it('builds a chain alias line that routes through the router', () => {
      expect(getChainAliasLine('default')).toBe(
        "alias claude-default='claude-profiles run --chain default --'"
      );
    });

    it('wraps the alias in a marked block', () => {
      const block = getChainAliasBlock('default');
      expect(block).toContain('# claude-profiles chain: default');
      expect(block).toContain(getChainAliasLine('default'));
    });

    it('installs and replaces (not duplicates) a chain alias', async () => {
      await installChainAlias('default', '.zshrc');
      await installChainAlias('default', '.zshrc');
      const content = await fs.readFile(path.join(tempDir, '.zshrc'), 'utf-8');
      const matches = content.match(/# claude-profiles chain: default/g);
      expect(matches?.length).toBe(1);
      expect(content).toContain(getChainAliasLine('default'));
    });

    it('removes a chain alias without touching a same-named profile alias', async () => {
      const profile: Profile = {
        alias: 'claude-default',
        configDir: path.join(tempDir, '.claude-default'),
      };
      // A profile alias and a chain alias can coexist with the same name.
      await installShellAlias('default', profile, '.zshrc');
      await installChainAlias('default', '.zshrc');

      const removed = await removeChainAlias('default', '.zshrc');
      expect(removed).toBe(true);

      const content = await fs.readFile(path.join(tempDir, '.zshrc'), 'utf-8');
      expect(content).not.toContain('# claude-profiles chain: default');
      expect(content).toContain('# claude-profiles profile: default');
    });

    it('removeChainAlias returns false when nothing is installed', async () => {
      await fs.writeFile(path.join(tempDir, '.zshrc'), '# nothing here\n');
      expect(await removeChainAlias('default', '.zshrc')).toBe(false);
    });
  });
});
