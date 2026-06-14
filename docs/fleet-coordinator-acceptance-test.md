# Fleet Coordinator — Multi-Agent + Plan-Mode Acceptance Test

A repeatable, documentable QA protocol for the **fleet coordinator**: a lead profile
launched as an official Claude Code **Remote Control** session
(`claude-profiles fleet coordinator --lead josh --server`) with the fleet MCP attached,
steered from **claude.ai/code or the Claude mobile app**.

The point of this test is to prove three things, with evidence, end to end:

1. **It runs locally.** Remote Control is *not* the cloud. claude.ai/code is a remote
   screen into a `claude` process on your machine; prompts execute against your local
   filesystem and your local fleet MCP.
2. **It fans out.** One device-steered session can delegate real work to several of your
   *other* OAuth accounts concurrently and synthesize the results.
3. **It plans.** The coordinator can enter plan mode, produce a multi-account execution
   plan, and — once you approve from the device — carry it out via the fleet.

Each phase below pairs a **device prompt** (what you type on the phone/browser) with an
**operator proof** (what the person at the machine observes). The proof signals are local
artifacts, so a passing run is positive evidence the work happened on your hardware.

---

## What "good" looks like (scoring rubric)

| Dimension | Pass bar | Stretch |
|---|---|---|
| **Locality** | `package.json` / `git branch` answered correctly from device | reads a file you create *after* connecting |
| **Connectivity** | `fleet_status` lists every profile with health | usage %/reset shown per account |
| **Single delegate** | one account's `lastUsedAt` advances past baseline | worker `sessionId` returned + resumable |
| **Parallel fan-out** | ≥2 accounts' `lastUsedAt` advance in the *same* poll | results returned in input order, merged coherently |
| **Plan mode** | coordinator emits a plan, waits for approval, then executes | plan explicitly assigns sub-tasks per account |
| **Threading** | a follow-up reuses worker context (`resume`) | coordinator session survives across prompts |
| **Resilience** | a rate-limited/cooled account is skipped, not fatal | cooldown recorded in `state.json` |
| **Billing hygiene** | workers run on subscription OAuth | `ANTHROPIC_API_KEY` scrubbed; no `--bare` |

Score = phases passed / phases attempted. A clean run is **8/8**. Anything that fails
should fail *loud* (visible error on the device), never silently.

---

## Prerequisites

- `claude` v2.1.51+ (Remote Control). Verify: `claude --version`.
- Lead + worker profiles authenticated with **claude.ai OAuth** (not API keys):
  `claude-profiles fleet status` shows them `healthy`.
- Fleet MCP registered into the lead's config (idempotent):
  ```bash
  CLAUDE_CONFIG_DIR=~/.claude-josh claude mcp list   # expect: fleet … ✔ Connected
  ```
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` **unset** in the coordinator's environment
  (either var disconnects Remote Control and overrides OAuth).

> Profile names in these examples: lead = `josh`, workers = `lockie`, `mini-trev`.
> Substitute your own. State lives at `~/.claude/.claude-profiles/state.json`.

---

## Step 0 — Launch the coordinator (operator)

```bash
# Server mode = drive entirely from a device. Prints the env URL when ready.
CLAUDE_PROFILES_BIN=claude-profiles \
  claude-profiles fleet coordinator --lead josh --server \
  --name "Fleet coordinator (josh)" | tee /tmp/coord.log
```

Open the printed URL on your phone (Claude app) or browser:
`https://claude.ai/code?environment=env_…`

---

## Step 0b — Arm the operator-side proof monitor

This poll loop is the spine of the test: it prints a line **only when something changes**
on the local machine — a worker's `lastUsedAt` advances, the local fleet MCP child count
changes, or the coordinator dies. Capture the baseline first.

```bash
STATE=~/.claude/.claude-profiles/state.json
jq -r '.profiles | to_entries[] | "\(.key)=\(.value.lastUsedAt // "never")"' "$STATE"
# ^ baseline, e.g. josh=…  lockie=2026-06-14T03:10:29.889Z  mini-trev=…
```

```bash
# Emits one line per change; otherwise silent. Ctrl-C to stop.
STATE=~/.claude/.claude-profiles/state.json
prev=""
while :; do
  coord=$(pgrep -f "claude remote-control" >/dev/null && echo up || echo DOWN)
  mcp=$(pgrep -fc "fleet --no-http")
  stamps=$(jq -rc '.profiles | to_entries | map("\(.key)=\(.value.lastUsedAt // "never")") | join(" ")' "$STATE")
  line="coord=$coord mcp_children=$mcp $stamps"
  [ "$line" != "$prev" ] && { date +"[%H:%M:%S] $line"; prev="$line"; }
  sleep 5
done
```

Any worker timestamp moving **past the baseline** = that account just ran a headless job
on this machine. Two moving in the same poll = concurrent fan-out.

---

## Phase 1 — Locality + connectivity

**Device prompt:**
> Call `fleet_status` and report each account's health. Then read `./package.json` and
> tell me the `name` field, and run `git branch --show-current`.

**Pass:** lists josh/lockie/mini-trev with health; answers `@vinniai/claude-profiles` and
the real branch. **Proof:** `mcp_children=1` in the monitor; the repo answer is impossible
from a cloud sandbox that lacks this checkout.

---

## Phase 2 — Single delegation

**Device prompt:**
> Use `delegate` to ask `lockie` to summarize `./README.md` in three bullets, then show me
> its summary and the worker's `sessionId`.

**Pass:** a real 3-bullet summary + a `sessionId`. **Proof:** monitor shows `lockie`
`lastUsedAt` advance past baseline; `mini-trev` unchanged.

---

## Phase 3 — Parallel multi-agent fan-out (the core)

**Device prompt:**
> Use `delegate_parallel`: have `lockie` list the top 3 risks in `src/lib/fleet.ts`, and
> `mini-trev` list the top 3 risks in `src/fleet/orchestrator.ts`. Then merge both into one
> prioritized list of 5, deduped, highest-severity first.

**Pass:** two distinct analyses come back and the coordinator merges them into one ranked
list. **Proof:** monitor shows **both** `lockie` and `mini-trev` `lastUsedAt` advance — and
because `delegate_parallel` dispatches them together, the two stamps typically land in the
*same* poll line. That's concurrent multi-account execution from a single device prompt.

---

## Phase 4 — Plan mode + multi-agent execution (the headline)

This is the full loop: coordinator plans, you approve from the device, fleet executes.

**Device prompt (enter plan mode first — Shift+Tab on web, or the plan toggle in the app):**
> We want a short CONTRIBUTING note for this repo. Plan it as a fleet job: assign one
> section to `lockie` (build/test workflow) and one to `mini-trev` (PR/commit conventions),
> to be run with `delegate_parallel`, then a synthesis step where you stitch them into a
> single `CONTRIBUTING.draft.md`. Show me the plan — don't execute yet.

**Pass (plan):** the coordinator returns a plan that explicitly names each account, the
sub-prompt each will get, and the merge step. It **waits** — nothing runs.

**Then approve:**
> Approved — execute the plan.

**Pass (execute):** it issues the `delegate_parallel`, collects both sections, writes
`CONTRIBUTING.draft.md` locally. **Proof:** both worker stamps advance again; the new file
exists on the machine:
```bash
ls -l CONTRIBUTING.draft.md && head CONTRIBUTING.draft.md
```
A file created by a device-issued, plan-approved fleet job, sitting on your local disk, is
the strongest single piece of evidence in this test.

---

## Phase 5 — Threading / resume

**Device prompt:**
> Continue with `lockie` (resume its session): ask it to turn its section into a numbered
> checklist instead of prose.

**Pass:** `lockie` revises *its own* prior output (proving context carried via `resume`),
not a cold restart. **Proof:** `lockie` `lastUsedAt` advances once more.

---

## Phase 6 — Resilience (optional, destructive to one account's availability)

Simulate a limited account and confirm the fleet degrades gracefully rather than failing.

**Operator (force a cooldown on one worker):**
```bash
# Park mini-trev in cooldown for 10 min via the CLI's own state path, then re-test.
claude-profiles chain reset            # clear first if needed
# (or hand-edit state.json: set profiles.mini-trev.cooldownUntil to a near-future ISO time)
```

**Device prompt:**
> Use `delegate_parallel` to have `lockie` and `mini-trev` each echo OK. Tell me exactly
> what happened for each.

**Pass:** `lockie` returns OK; `mini-trev` is reported as skipped/cooling — the call does
**not** hard-fail the whole batch. **Proof:** `state.json` shows `mini-trev` with a
`cooldownUntil`/`needsAuth`, and a later delegate respects it.

---

## Teardown (operator)

```bash
pkill -f "claude remote-control"      # stop the coordinator
# stop the monitor loop with Ctrl-C
rm -f CONTRIBUTING.draft.md           # if it was only a test artifact
```

---

## Reference run (2026-06-14, josh lead)

A live run of Phases 1–3 against `josh` + `lockie` + `mini-trev`, steered from
claude.ai/code, produced this monitor evidence (baseline `…03:10:29.889Z`):

```
[20:28:01] coord=up mcp_children=1 lockie=…03:10:29.889Z  mini-trev=…03:10:29.889Z   # armed, baseline
[20:32:58] coord=up mcp_children=1 lockie=…03:32:51.833Z  mini-trev=…03:10:29.889Z   # Phase 2: lockie advanced
[20:33:28] coord=up mcp_children=1 lockie=…03:33:17.690Z  mini-trev=…03:33:17.690Z   # Phase 3: both, same poll
```

Phase 2 moved `lockie` alone; Phase 3's `delegate_parallel` moved **both** to an identical
timestamp in one poll — concurrent multi-account delegation from one device-steered
session, every byte of it local. Phases 4–6 are documented above for the full matrix.

> **Why the timestamps are the proof:** `lastUsedAt` is written by `markUsed` in the fleet
> library *on the machine running the MCP server*. There is no path for a cloud instance to
> mutate your local `state.json`. The clock advancing is, by construction, local execution.
