import { Command } from 'commander';
import { loadProfiles } from '../lib/profiles.js';
import {
  loadHandoff,
  updateHandoff,
  summarizeTranscript,
  buildContinuationContext,
  profileNameForConfigDir,
} from '../lib/handoff.js';
import { setProfileCooldown, markNeedsAuth, getProfileState } from '../lib/state.js';
import { routableCandidatesFor, effectivePolicy } from '../lib/router.js';
import { decideAutoSwitch, computeCutover } from '../lib/cutover.js';
import { appendRoutingEvent, flushRoutingLog } from '../lib/routing-log.js';
import {
  classifyOutcome,
  shouldFailover,
  type FailureKind,
} from '../lib/claude-errors.js';
import {
  buildBudgetGuardrail,
  buildNotifyPayload,
  shouldForwardNotification,
  buildSubagentEvent,
} from '../lib/hook-events.js';

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

const WEBHOOK_TIMEOUT_MS = 4000;

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
  /** Notification hook: the message Claude Code would surface to the user. */
  message?: string;
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

/**
 * SessionStart: inject continuation context once. Two one-shot triggers:
 *  - `pendingFailover`: a different account is picking up after the prior one
 *    became unavailable.
 *  - `pendingResume`: the same coordinator is reconnecting/relaunching and
 *    continuing its own last conversation (server-mode remote control can't
 *    `--resume`, so we restore context via this hook instead).
 * Failover wins if both are set. The flag is cleared after injecting so only the
 * first new session resumes and a later clean start does not re-inject.
 */
async function onSessionStart(input: HookInput, chain: string): Promise<void> {
  const record = await loadHandoff(chain);
  if (!record || !record.summary) return;

  let mode: 'failover' | 'resume' | null = null;
  if (record.pendingFailover) mode = 'failover';
  else if (record.pendingResume) mode = 'resume';
  if (!mode) return;

  // Emit the additionalContext, then clear the consumed flag so a later clean
  // start (or a sibling spawned session) does not re-inject it.
  const context = buildContinuationContext(record, mode);
  await updateHandoff(chain, {
    pendingFailover: mode === 'failover' ? false : record.pendingFailover,
    pendingResume: mode === 'resume' ? false : record.pendingResume,
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
async function onSnapshot(
  input: HookInput,
  chain: string,
  event: string
): Promise<void> {
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
    return;
  }

  // No error this turn — on a Stop boundary, consider a PROACTIVE auto-switch.
  if (event === 'Stop' && activeProfile) {
    await maybeAutoSwitch(chain, activeProfile, summary, now);
  }
}

/**
 * Proactive turn-boundary auto-switch. When a routing rule (over-cap / schedule
 * window / drain) now favours a different account, stage a switch directive for
 * the interactive supervisor and end this turn's processing with `continue:false`
 * so `claude` exits and the supervisor relaunches on the chosen account (the
 * SessionStart hook then restores context). Degrades safely: if `continue:false`
 * doesn't force an exit, the staged directive simply applies at the next natural
 * exit. Best-effort and side-effect-light — any failure leaves the turn alone.
 */
async function maybeAutoSwitch(
  chain: string,
  activeProfile: string,
  summary: string,
  now: Date
): Promise<void> {
  // Opt-out: the launcher sets this when run with --no-auto-switch, and the
  // config can disable it globally/per-chain.
  if (process.env.CLAUDE_PROFILES_NO_AUTOSWITCH === '1') return;
  const config = await loadProfiles();
  const chainAuto = config.chainRouting?.[chain]?.autoSwitch;
  const globalAuto = config.routing?.autoSwitch;
  if (chainAuto === false || (chainAuto == null && globalAuto === false)) return;

  // Idempotent: never stack a second directive on top of a pending one.
  const existing = await loadHandoff(chain);
  if (existing?.pendingSwitchTo) return;

  const built = await routableCandidatesFor({
    config,
    chain,
    account: activeProfile,
    now,
  });
  if (!built) return;

  const decision = decideAutoSwitch({
    candidates: built.candidates,
    current: activeProfile,
    strategy: built.strategy,
    now,
  });
  if (!decision || decision.to === activeProfile) return;

  // Stage the directive + restore-context flag, then nudge `claude` to exit so
  // the supervisor relaunches on the chosen account.
  await updateHandoff(
    chain,
    {
      pendingSwitchTo: decision.to,
      pendingSwitchReason: decision.reason,
      pendingSwitchKind: decision.kind,
      // Reuse the failover path so SessionStart re-injects the running summary
      // on the account we switch to.
      pendingFailover: true,
      failoverKind: decision.kind,
      summary: summary || existing?.summary || undefined,
    },
    now
  );

  await appendRoutingEvent({
    kind: decision.kind,
    from: activeProfile,
    to: decision.to,
    chain,
    mode: 'interactive',
    reason: decision.reason,
  });
  await flushRoutingLog();

  process.stdout.write(
    JSON.stringify({
      continue: false,
      stopReason: `↪ switching to "${decision.to}" — ${decision.reason}. Restoring context there…`,
    })
  );
}

/**
 * UserPromptSubmit: a cheap per-turn budget guardrail. When the active account
 * is near (or over) its effective session cap, inject a short note as
 * `additionalContext` so the model — and the user reading the turn — know a
 * switch is coming. Read-only and best-effort; emits nothing when there's no cap
 * configured, no usage figure, or comfortable headroom.
 */
async function onUserPromptSubmit(_input: HookInput, chain: string): Promise<void> {
  const now = new Date();
  const config = await loadProfiles();
  const profile = profileNameForConfigDir(
    config.profiles,
    process.env.CLAUDE_CONFIG_DIR
  );
  if (!profile) return;

  const s = await getProfileState(profile);
  const cutover = computeCutover({
    session: s.usage?.session,
    policy: effectivePolicy(config, chain, profile),
    override: s.capOverride,
    burn: s.burn,
    now,
  });

  const note = buildBudgetGuardrail({ profile, cutover });
  if (!note) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: note,
      },
    })
  );
}

/** POST a Discord/Slack-compatible `{ content }` body to a webhook, best-effort. */
async function postWebhook(url: string, content: string): Promise<void> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: ctrl.signal,
    });
  } catch {
    // Best-effort — a failed push must never disturb the host CLI.
  } finally {
    clearTimeout(to);
  }
}

/**
 * Notification: forward Claude Code's "waiting for input / needs permission"
 * pings to the configured webhook (e.g. a Discord channel) so they reach your
 * phone, tagged with which chain/account is waiting. No-op unless `notify` is
 * configured.
 */
async function onNotification(input: HookInput, chain: string): Promise<void> {
  const config = await loadProfiles();
  const notify = config.notify;
  const message = input.message ?? '';
  if (!shouldForwardNotification(notify, message)) return;

  const profile = profileNameForConfigDir(
    config.profiles,
    process.env.CLAUDE_CONFIG_DIR
  );
  const { content } = buildNotifyPayload({ message, profile, chain });
  await postWebhook(notify!.webhookUrl!, content);
}

/**
 * SubagentStop: record a subagent completion in the routing log so delegate /
 * fleet work shows up in the routing history under the active account.
 */
async function onSubagentStop(input: HookInput, chain: string): Promise<void> {
  const config = await loadProfiles();
  const profile = profileNameForConfigDir(
    config.profiles,
    process.env.CLAUDE_CONFIG_DIR
  );

  const { lastAssistantText } = await summarizeTranscript(input.transcript_path);
  const reason = lastAssistantText
    ? `subagent completed — ${lastAssistantText.slice(0, 140)}`
    : 'subagent completed';

  await appendRoutingEvent(buildSubagentEvent({ profile: profile ?? null, chain, reason }));
  await flushRoutingLog();
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
        await onSnapshot(input, chain, event);
      } else if (event === 'UserPromptSubmit') {
        await onUserPromptSubmit(input, chain);
      } else if (event === 'Notification') {
        await onNotification(input, chain);
      } else if (event === 'SubagentStop') {
        await onSubagentStop(input, chain);
      }
    } catch {
      // Never let a hook failure surface into the host CLI.
    }
  });
