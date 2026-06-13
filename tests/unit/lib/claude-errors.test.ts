import { describe, it, expect } from 'vitest';
import {
  classifyOutcome,
  parseResetTime,
  shouldFailover,
} from '../../../src/lib/claude-errors.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

describe('classifyOutcome', () => {
  it('treats a clean exit 0 as success without scanning text', () => {
    const out = classifyOutcome(
      { exitCode: 0, stdout: 'all good, no rate limit here', stderr: '' },
      NOW
    );
    expect(out.ok).toBe(true);
    expect(out.kind).toBe('none');
  });

  it('detects usage limit reached as rate_limit', () => {
    const out = classifyOutcome(
      { exitCode: 1, stdout: '', stderr: 'Claude usage limit reached' },
      NOW
    );
    expect(out.ok).toBe(false);
    expect(out.kind).toBe('rate_limit');
  });

  it('detects HTTP 429 as rate_limit', () => {
    const out = classifyOutcome(
      { exitCode: 1, stdout: '', stderr: 'Error: 429 Too Many Requests' },
      NOW
    );
    expect(out.kind).toBe('rate_limit');
  });

  it('detects overloaded as server_error', () => {
    const out = classifyOutcome(
      { exitCode: 1, stdout: '', stderr: 'API Error: 529 Overloaded' },
      NOW
    );
    expect(out.kind).toBe('server_error');
  });

  it('detects 401/expired token as auth', () => {
    const out = classifyOutcome(
      { exitCode: 1, stdout: '', stderr: 'OAuth token has expired, please run /login' },
      NOW
    );
    expect(out.kind).toBe('auth');
  });

  it('classifies a JSON envelope with is_error + rate limit message', () => {
    const json = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'You have reached your usage limit for Claude.',
    });
    const out = classifyOutcome({ exitCode: 0, stdout: json, stderr: '' }, NOW);
    expect(out.ok).toBe(false);
    expect(out.kind).toBe('rate_limit');
  });

  it('does not fail over on a generic non-zero exit', () => {
    const out = classifyOutcome(
      { exitCode: 2, stdout: '', stderr: 'TypeError: cannot read property x of undefined' },
      NOW
    );
    expect(out.kind).toBe('other');
    expect(shouldFailover(out.kind)).toBe(false);
  });

  it('prioritises rate_limit over server_error when both words appear', () => {
    const out = classifyOutcome(
      { exitCode: 1, stdout: '', stderr: 'rate limit hit; service unavailable' },
      NOW
    );
    expect(out.kind).toBe('rate_limit');
  });
});

describe('shouldFailover', () => {
  it('only the three eligible kinds trigger failover', () => {
    expect(shouldFailover('rate_limit')).toBe(true);
    expect(shouldFailover('server_error')).toBe(true);
    expect(shouldFailover('auth')).toBe(true);
    expect(shouldFailover('other')).toBe(false);
    expect(shouldFailover('none')).toBe(false);
  });
});

describe('parseResetTime', () => {
  it('parses a unix epoch (seconds)', () => {
    const epoch = 1718200800; // 2024-...
    const d = parseResetTime(`"resets_at": ${epoch}`, NOW);
    expect(d?.getTime()).toBe(epoch * 1000);
  });

  it('parses a human "resets at 3:45pm" and rolls to tomorrow if passed', () => {
    const d = parseResetTime('Your limit resets at 3:45pm', NOW);
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('returns null when nothing parseable', () => {
    expect(parseResetTime('no time here', NOW)).toBeNull();
  });
});
