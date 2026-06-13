import { describe, it, expect } from 'vitest';
import {
  parseUnifiedRateLimits,
  parseRateLimitDetail,
  usageBudgetFromApiBody,
} from '../../../src/lib/usage-api.js';

const NOW = new Date('2026-06-13T12:00:00.000Z');

// A faithful slice of a real `ANTHROPIC_LOG=debug` header dump (josh / max-20x).
const REAL_HEADERS = `
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1781354400",
  "anthropic-ratelimit-unified-5h-utilization": "0.26",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1781528400",
  "anthropic-ratelimit-unified-7d-utilization": "0.1",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-overage-status": "rejected",
`;

describe('parseUnifiedRateLimits', () => {
  it('maps 5h/7d utilization + reset onto session/weekly windows', () => {
    const budget = parseUnifiedRateLimits(REAL_HEADERS, NOW);
    expect(budget).toBeDefined();
    expect(budget!.session?.usedPct).toBe(26);
    expect(budget!.weekly?.usedPct).toBe(10);
    // epoch seconds → ISO
    expect(budget!.session?.resetAt).toBe(new Date(1781354400 * 1000).toISOString());
    expect(budget!.weekly?.resetAt).toBe(new Date(1781528400 * 1000).toISOString());
    expect(budget!.session?.source).toBe('observed');
    expect(budget!.session?.observedAt).toBe(NOW.toISOString());
  });

  it('returns undefined when no unified headers are present', () => {
    expect(parseUnifiedRateLimits('just some normal stderr output', NOW)).toBeUndefined();
    expect(parseUnifiedRateLimits('', NOW)).toBeUndefined();
  });

  it('tolerates header-style (key: val) as well as JSON rendering', () => {
    const headerStyle =
      'anthropic-ratelimit-unified-5h-utilization: 0.5\n' +
      'anthropic-ratelimit-unified-5h-reset: 1781354400';
    const budget = parseUnifiedRateLimits(headerStyle, NOW);
    expect(budget!.session?.usedPct).toBe(50);
  });

  it('handles a window with only a reset (no utilization)', () => {
    const onlyReset = 'anthropic-ratelimit-unified-7d-reset": "1781528400"';
    const budget = parseUnifiedRateLimits(onlyReset, NOW);
    expect(budget!.weekly?.resetAt).toBeDefined();
    expect(budget!.weekly?.usedPct).toBeUndefined();
  });
});

describe('parseRateLimitDetail', () => {
  it('extracts standing / representative-claim / overage', () => {
    const d = parseRateLimitDetail(REAL_HEADERS);
    expect(d).toEqual({
      status: 'allowed',
      representativeClaim: 'five_hour',
      overageStatus: 'rejected',
    });
  });

  it('returns undefined without a unified header block', () => {
    expect(parseRateLimitDetail('nothing here')).toBeUndefined();
  });
});

describe('usageBudgetFromApiBody (tolerant)', () => {
  it('reads a nested five_hour / seven_day shape', () => {
    const body = {
      five_hour: { utilization: 0.26, resets_at: 1781354400 },
      seven_day: { utilization: 0.1, resets_at: 1781528400 },
    };
    const budget = usageBudgetFromApiBody(body, NOW);
    expect(budget!.session?.usedPct).toBe(26);
    expect(budget!.weekly?.usedPct).toBe(10);
    expect(budget!.session?.resetAt).toBe(new Date(1781354400 * 1000).toISOString());
  });

  it('reads a flat *_utilization shape', () => {
    const body = { five_hour_utilization: 0.4, seven_day_utilization: 0.2 };
    const budget = usageBudgetFromApiBody(body, NOW);
    expect(budget!.session?.usedPct).toBe(40);
    expect(budget!.weekly?.usedPct).toBe(20);
  });

  it('accepts an already-percent used_pct field', () => {
    const body = { session: { used_pct: 73 } };
    const budget = usageBudgetFromApiBody(body, NOW);
    expect(budget!.session?.usedPct).toBe(73);
  });

  it('returns undefined for an unrecognizable body', () => {
    expect(usageBudgetFromApiBody({ unrelated: true }, NOW)).toBeUndefined();
    expect(usageBudgetFromApiBody(null, NOW)).toBeUndefined();
  });
});
