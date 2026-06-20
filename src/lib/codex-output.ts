export interface CodexExecOutput {
  threadId?: string;
  text: string;
  failed: boolean;
  errorText: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
}

/**
 * Parse `codex exec --json` JSONL into the provider-neutral fields used by the
 * fleet. Unknown events are ignored so newer Codex releases remain compatible.
 */
export function parseCodexJsonl(stdout: string): CodexExecOutput {
  let threadId: string | undefined;
  let text = '';
  let failed = false;
  const errors: string[] = [];
  let usage: CodexExecOutput['usage'];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
      continue;
    }

    if (event.type === 'item.completed') {
      const item =
        event.item && typeof event.item === 'object'
          ? (event.item as Record<string, unknown>)
          : undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        text = item.text;
      }
      continue;
    }

    if (event.type === 'turn.completed') {
      const raw =
        event.usage && typeof event.usage === 'object'
          ? (event.usage as Record<string, unknown>)
          : undefined;
      if (raw) {
        const number = (key: string): number | undefined =>
          typeof raw[key] === 'number' ? (raw[key] as number) : undefined;
        usage = {
          inputTokens: number('input_tokens'),
          cachedInputTokens: number('cached_input_tokens'),
          outputTokens: number('output_tokens'),
          reasoningOutputTokens: number('reasoning_output_tokens'),
        };
      }
      continue;
    }

    if (event.type === 'turn.failed' || event.type === 'error') {
      failed = true;
      const error =
        event.error && typeof event.error === 'object'
          ? (event.error as Record<string, unknown>)
          : undefined;
      const message = [event.message, error?.message, error?.type]
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
      if (message) errors.push(message);
    }
  }

  return {
    threadId,
    text,
    failed,
    errorText: errors.join('\n'),
    usage,
  };
}
