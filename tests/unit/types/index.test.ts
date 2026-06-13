import { describe, it, expect } from 'vitest';
import {
  ClaudeProfilesError,
  ErrorCode,
} from '../../../src/types/index.js';

describe('ClaudeProfilesError', () => {
  it('should create error with message and code', () => {
    const error = new ClaudeProfilesError(
      'Test error message',
      ErrorCode.NOT_INITIALIZED
    );

    expect(error.message).toBe('Test error message');
    expect(error.code).toBe(ErrorCode.NOT_INITIALIZED);
    expect(error.suggestion).toBeUndefined();
    expect(error.name).toBe('ClaudeProfilesError');
    expect(error instanceof Error).toBe(true);
  });

  it('should create error with message, code, and suggestion', () => {
    const error = new ClaudeProfilesError(
      'Test error message',
      ErrorCode.NOT_INITIALIZED,
      'Run claude-profiles init first'
    );

    expect(error.message).toBe('Test error message');
    expect(error.code).toBe(ErrorCode.NOT_INITIALIZED);
    expect(error.suggestion).toBe('Run claude-profiles init first');
  });

  it('should have correct error codes enum', () => {
    expect(ErrorCode.NOT_INITIALIZED).toBe('NOT_INITIALIZED');
    expect(ErrorCode.NOT_GIT_REPO).toBe('NOT_GIT_REPO');
    expect(ErrorCode.NO_REMOTE).toBe('NO_REMOTE');
    expect(ErrorCode.MERGE_CONFLICT).toBe('MERGE_CONFLICT');
    expect(ErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    expect(ErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(ErrorCode.INVALID_CONFIG).toBe('INVALID_CONFIG');
    expect(ErrorCode.UNSUPPORTED_PLATFORM).toBe('UNSUPPORTED_PLATFORM');
    expect(ErrorCode.ALREADY_EXISTS).toBe('ALREADY_EXISTS');
    expect(ErrorCode.CLONE_FAILED).toBe('CLONE_FAILED');
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ErrorCode.ALL_PROFILES_EXHAUSTED).toBe('ALL_PROFILES_EXHAUSTED');
    expect(ErrorCode.CLAUDE_NOT_FOUND).toBe('CLAUDE_NOT_FOUND');
    expect(ErrorCode.NO_CHAIN).toBe('NO_CHAIN');
  });

  it('should maintain stack trace', () => {
    const error = new ClaudeProfilesError(
      'Test error',
      ErrorCode.NOT_INITIALIZED
    );

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('ClaudeProfilesError');
  });
});
