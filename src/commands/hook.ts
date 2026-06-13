import { Command } from 'commander';
import { loadProfiles } from '../lib/profiles.js';
import {
  loadHandoff,
  updateHandoff,
  summarizeTranscript,
  buildContinuationContext,
  profileNameForConfigDir,
} from '../lib/handoff.js';
import { setProfileCooldown, markNeedsAuth } from '../lib/state.js';
import {
  classifyOutcome,
  shouldFailover,
  type FailureKind,
} from '../lib/claude-errors.js';

/**
 * Hidden dispatcher for Claude Code hooks. Wired into the user's shared
 * settings.json as `claude-profiles _hook <Event>`. It reads the hook JSON from
 * stdin plus the `CLAUDE_PROFILES_*` env vars our launcher sets, and:
 *  - SessionStart: injects prior context after a failover (then clears the flag).
 *  - Stop / SessionEnd / PreCompact: snapshots the transcript to the shared
 *    handoff dir and, on a limit/auth error, records the active profile's cooldown.
 *
 * It is a strict no-op unless a chain launched the session (CLAUDE_PROFILES_CHAIN
 * is set), so it never disturbs normal `claude` usage. It must never throw or
 * print anything that would corrupt the host CLI — all paths swallow errors.
 */

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const SERVER_ERROR_COOLDOWN_MS = 2 * 60 * 1000;

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const to = setTimeout(() => resolve(data), 2000);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(to);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(to);
      resolve(data);
    });
  });
}

function parseInput(raw: string): HookInput {
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

async function recordCooldown(
  profile: string,
  kind: FailureKind,
  reason: string,
  resetAt: Date | null,
  now: Date
): Promise<void> {
  if (kind === 'auth') {
    await markNeedsAuth(profile, reason, now);
    return;
  }
  if (kind === 'rate_limit') {
    const until =
      resetAt && resetAt.getTime() > now.getTime()
        ? resetAt
        : new Date(now.getTime() + RATE_LIMIT_COOLDOWN_MS);
    await setProfileCooldown(profile, until, reason, now);
    return;
  }
  if (kind === 'server_error') {
    await setProfileCooldown(
      profile,
      new Date(now.getTime() + SERVER_ERROR_COOLDOWN_MS),
      reason,
      now
    );
  }
}

/** SessionStart: inject continuation context once, after a failover. */
async function onSessionStart(input: HookInput, chain: string): Promise<void> {
  const record = await loadHandoff(chain);
  if (!record || !record.pendingFailover || !record.summary) return;

  // Emit the additionalContext, then clear the pending flag so a later clean
  // start does not re-inject it.
  const context = buildContinuationContext(record);
  await updateHandoff(chain, {
    pendingFailover: false,
    lastSessionId: input.session_id,
  });

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  );
}

/** Stop / SessionEnd / PreCompact: snapshot + classify for cooldown. */
async function onSnapshot(input: HookInput, chain: string): Promise<void> {
  const now = new Date();
  const config = await loadProfiles();
  const activeProfile = profileNameForConfigDir(
    config.profiles,
    process.env.CLAUDE_CONFIG_DIR
  );
  const threadId =
    process.env.CLAUDE_PROFILES_THREAD ??
    (await loadHandoff(chain))?.threadId ??
    `${chain}-thread`;

  const { summary, lastAssistantText } = await summarizeTranscript(
    input.transcript_path
  );

  // Classify the most recent assistant text for a failover-eligible error.
  const outcome = classifyOutcome(
    { exitCode: 1, stdout: lastAssistantText, stderr: '' },
    now
  );
  const failover = !outcome.ok && shouldFailover(outcome.kind);

  await updateHandoff(
    chain,
    {
      threadId,
      lastProfile: activeProfile,
      lastSessionId: input.session_id,
      transcriptPath: input.transcript_path,
      summary: summary || undefined,
      pendingFailover: failover || undefined,
      failoverKind: failover ? outcome.kind : undefined,
    },
    now
  );

  if (failover && activeProfile) {
    await recordCooldown(
      activeProfile,
      outcome.kind,
      outcome.reason,
      outcome.resetAt ?? null,
      now
    );
  }
}

export const hookCommand = new Command('_hook')
  .description('(internal) Claude Code hook dispatcher for continuity/failover')
  .argument('<event>', 'Hook event name')
  .allowUnknownOption()
  .action(async (event: string) => {
    try {
      const chain = process.env.CLAUDE_PROFILES_CHAIN;
      if (!chain) return; // Not launched through a chain — no-op.

      const input = parseInput(await readStdin());
      if (event === 'SessionStart') {
        await onSessionStart(input, chain);
      } else if (
        event === 'Stop' ||
        event === 'SessionEnd' ||
        event === 'PreCompact'
      ) {
        await onSnapshot(input, chain);
      }
    } catch {
      // Never let a hook failure surface into the host CLI.
    }
  });
