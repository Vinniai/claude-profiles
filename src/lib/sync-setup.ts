import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';
import { confirm, input } from '../utils/prompts.js';
import { isGitRepo, createGit, initRepo, addRemote, testRemoteConnection, cloneRepo } from './git.js';
import { readMetaJson } from './sync.js';
import { ClaudeProfilesError, ErrorCode } from '../types/index.js';

async function warnIfNotClaudeProfilesRepo(dir: string): Promise<void> {
  const meta = await readMetaJson(dir);
  // Accept both the new value and the legacy 'jean-claude' value (back-compat)
  if (meta?.managedBy === 'claude-profiles' || meta?.managedBy === 'jean-claude') return;

  logger.warn('This repository does not appear to be a claude-profiles config repo.');
  logger.dim('It may overwrite your Claude Code configuration with unrelated files.');
  const proceed = await confirm('Continue anyway?', false);
  if (!proceed) {
    throw new ClaudeProfilesError(
      'Setup cancelled — repository validation failed',
      ErrorCode.INVALID_CONFIG,
      'Use a repository created by "claude-profiles init" with syncing enabled.'
    );
  }
}

/**
 * Interactive Git remote setup flow.
 * Used by both `claude-profiles init` (when user opts in) and `claude-profiles sync setup`.
 */
export async function setupGitSync(claudeProfilesDir: string, urlArg?: string): Promise<void> {
  const isRepo = await isGitRepo(claudeProfilesDir);

  if (isRepo) {
    // Already a git repo — check if remote is configured
    const git = createGit(claudeProfilesDir);
    const remotes = await git.getRemotes(true);
    if (remotes.length > 0) {
      const origin = remotes.find(r => r.name === 'origin');
      const currentUrl = origin?.refs?.fetch || 'unknown';

      logger.success('Syncing is already configured.');
      logger.dim(`Current remote: ${currentUrl}`);

      if (!urlArg) {
        return;
      }

      const newUrl = urlArg.trim();
      if (newUrl && newUrl !== currentUrl) {
        await git.remote(['set-url', 'origin', newUrl]);
        logger.success('Remote URL updated.');
      } else {
        logger.dim('Remote URL unchanged.');
      }
      return;
    }
  }

  let repoUrl = urlArg;
  if (!repoUrl) {
    // Explain what's needed
    console.log('');
    logger.dim('Paste the URL of your existing config repo, or create a new');
    logger.dim('empty repo (e.g. "my-claude-config") on GitHub/GitLab.');
    console.log('');

    repoUrl = await input('Repository URL:');
  }

  if (!repoUrl.trim()) {
    throw new ClaudeProfilesError(
      'No repository URL provided',
      ErrorCode.INVALID_CONFIG,
      'Provide a Git repository URL (e.g. git@github.com:user/repo.git).'
    );
  }

  // Test connection to remote
  logger.step(1, 2, 'Testing connection to repository...');
  const canConnect = await testRemoteConnection(repoUrl);
  if (!canConnect) {
    throw new ClaudeProfilesError(
      'Cannot connect to repository',
      ErrorCode.NETWORK_ERROR,
      'Check that the URL is correct and you have access.'
    );
  }
  logger.success('Connection successful');

  // Set up the git repo
  logger.step(2, 2, 'Setting up local repository...');

  if (isRepo) {
    // Already a git repo but no remote — just add the remote
    await addRemote(claudeProfilesDir, repoUrl);
    logger.success('Remote added to existing repository');
  } else {
    // Not a git repo — need to set up git
    const dirContents = await fs.readdir(claudeProfilesDir);

    if (dirContents.length === 0) {
      // Empty directory — clone directly
      try {
        await cloneRepo(repoUrl, claudeProfilesDir);
        const cloneGit = createGit(claudeProfilesDir);
        const hasCommits = await cloneGit.log().then(log => log.total > 0).catch(() => false);
        if (hasCommits) {
          await warnIfNotClaudeProfilesRepo(claudeProfilesDir);
          logger.success('Cloned existing config from repository');
        } else {
          logger.success('Initialized new repository');
        }
      } catch (error) {
        if (error instanceof ClaudeProfilesError && error.code !== ErrorCode.CLONE_FAILED) throw error;
        await initRepo(claudeProfilesDir);
        await addRemote(claudeProfilesDir, repoUrl);
        logger.success('Initialized new repository');
      }
    } else {
      // Non-empty directory (e.g. has meta.json) — clone to temp, move .git over
      const tmpDir = path.join(os.tmpdir(), `claude-profiles-clone-${Date.now()}`);
      try {
        await cloneRepo(repoUrl, tmpDir);
        const tmpGit = createGit(tmpDir);
        const hasCommits = await tmpGit.log().then(log => log.total > 0).catch(() => false);
        if (hasCommits) {
          await warnIfNotClaudeProfilesRepo(tmpDir);
          await fs.move(path.join(tmpDir, '.git'), path.join(claudeProfilesDir, '.git'));
          const git = createGit(claudeProfilesDir);
          await git.reset(['HEAD']);
          logger.success('Cloned existing config from repository');
        } else {
          // Empty remote — take the .git (has origin configured), skip reset
          await fs.move(path.join(tmpDir, '.git'), path.join(claudeProfilesDir, '.git'));
          logger.success('Initialized new repository');
        }
      } catch (error) {
        if (error instanceof ClaudeProfilesError && error.code !== ErrorCode.CLONE_FAILED) throw error;
        await initRepo(claudeProfilesDir);
        await addRemote(claudeProfilesDir, repoUrl);
        logger.success('Initialized new repository');
      } finally {
        await fs.remove(tmpDir);
      }
    }
  }
}
