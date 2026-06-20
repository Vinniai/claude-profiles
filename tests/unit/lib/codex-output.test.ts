import { describe, expect, it } from 'vitest';
import { parseCodexJsonl } from '../../../src/lib/codex-output.js';

describe('parseCodexJsonl', () => {
  it('extracts thread, final agent message, and token usage', () => {
    const output = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'first' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'final answer' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
      }),
    ].join('\n');

    expect(parseCodexJsonl(output)).toMatchObject({
      threadId: 'thread-1',
      text: 'final answer',
      failed: false,
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 },
    });
  });

  it('captures machine-readable failure events', () => {
    const output = JSON.stringify({
      type: 'turn.failed',
      error: { type: 'rate_limit_error', message: '429 too many requests' },
    });
    expect(parseCodexJsonl(output)).toMatchObject({
      failed: true,
      errorText: expect.stringContaining('429'),
    });
  });
});
