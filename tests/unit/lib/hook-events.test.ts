import { describe, it, expect } from 'vitest';
import {
  buildBudgetGuardrail,
  buildNotifyPayload,
  shouldForwardNotification,
  buildSubagentEvent,
} from '../../../src/lib/hook-events.js';
import type { CutoverInfo } from '../../../src/lib/cutover.js';
import type { NotifyConfig } from '../../../src/types/index.js';

const cutover = (over: Partial<CutoverInfo>): CutoverInfo => ({
  overCap: false,
  overridden: false,
  ...over,
});

describe('buildBudgetGuardrail', () => {
  it('returns null when usage percent is unknown', () => {
    expect(
      buildBudgetGuardrail({ profile: 'alice', cutover: cutover({ capPct: 90 }) })
    ).toBeNull();
  });

  it('returns null when there is no cap configured', () => {
    expect(
      buildBudgetGuardrail({ profile: 'alice', cutover: cutover({ usedPct: 95 }) })
    ).toBeNull();
  });

  it('returns null with comfortable headroom', () => {
    expect(
      buildBudgetGuardrail({
        profile: 'alice',
        cutover: cutover({ usedPct: 40, capPct: 90, remainingPct: 50 }),
      })
    ).toBeNull();
  });

  it('warns when within the warn threshold of the cap', () => {
    const msg = buildBudgetGuardrail({
      profile: 'alice',
      cutover: cutover({
        usedPct: 84,
        capPct: 90,
        remainingPct: 6,
        etaMin: 12,
        etaTurns: 3,
      }),
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('alice');
    expect(msg).toContain('84%');
    expect(msg).toContain('12 min');
    expect(msg).toContain('3 turns');
  });

  it('flags an over-cap account and mentions the upcoming switch', () => {
    const msg = buildBudgetGuardrail({
      profile: 'bob',
      cutover: cutover({ usedPct: 96, capPct: 90, remainingPct: -6, overCap: true }),
    });
    expect(msg).not.toBeNull();
    expect(msg!.toLowerCase()).toContain('over its session cap');
    expect(msg!.toLowerCase()).toContain('switch');
  });

  it('respects a custom warn threshold', () => {
    // 80% used, cap 90 → 10 points remaining. Default warns at 10; a tighter
    // threshold of 5 should stay quiet.
    const within = cutover({ usedPct: 80, capPct: 90, remainingPct: 10 });
    expect(buildBudgetGuardrail({ profile: 'a', cutover: within })).not.toBeNull();
    expect(
      buildBudgetGuardrail({ profile: 'a', cutover: within, warnAtRemainingPct: 5 })
    ).toBeNull();
  });
});

describe('buildNotifyPayload', () => {
  it('prefixes chain/profile context', () => {
    const { content } = buildNotifyPayload({
      message: 'Claude is waiting for your input',
      profile: 'alice',
      chain: 'default',
    });
    expect(content).toContain('default/alice');
    expect(content).toContain('Claude is waiting for your input');
  });

  it('falls back to just the profile when no chain', () => {
    const { content } = buildNotifyPayload({ message: 'hi', profile: 'alice' });
    expect(content).toContain('alice');
    expect(content).not.toContain('/');
  });

  it('handles a blank message', () => {
    const { content } = buildNotifyPayload({ message: '   ', profile: null, chain: null });
    expect(content).toContain('notification');
  });
});

describe('shouldForwardNotification', () => {
  const cfg = (n: Partial<NotifyConfig>): NotifyConfig => ({ ...n });

  it('is false when no webhook is configured', () => {
    expect(shouldForwardNotification(undefined, 'anything')).toBe(false);
    expect(shouldForwardNotification(cfg({}), 'anything')).toBe(false);
  });

  it('forwards everything when no event filter is set', () => {
    expect(
      shouldForwardNotification(cfg({ webhookUrl: 'https://x' }), 'waiting for input')
    ).toBe(true);
  });

  it('only forwards messages matching an event filter (case-insensitive)', () => {
    const c = cfg({ webhookUrl: 'https://x', events: ['waiting', 'permission'] });
    expect(shouldForwardNotification(c, 'Claude is WAITING for input')).toBe(true);
    expect(shouldForwardNotification(c, 'needs your permission')).toBe(true);
    expect(shouldForwardNotification(c, 'idle background tick')).toBe(false);
  });
});

describe('buildSubagentEvent', () => {
  it('builds a subagent routing-log entry tied to the active profile', () => {
    const ev = buildSubagentEvent({ profile: 'alice', chain: 'default' });
    expect(ev.kind).toBe('subagent');
    expect(ev.chain).toBe('default');
    expect(ev.from).toBe('alice');
    expect(ev.to).toBe('alice');
    expect(ev.mode).toBe('interactive');
    expect(ev.reason).toBeTruthy();
  });

  it('carries a custom reason and tolerates an unknown profile', () => {
    const ev = buildSubagentEvent({ profile: null, chain: 'work', reason: 'review done' });
    expect(ev.reason).toBe('review done');
    expect(ev.from).toBeUndefined();
    expect(ev.to).toBeUndefined();
  });
});
