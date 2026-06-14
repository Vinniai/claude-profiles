# Fleet Coordinator — Showcase Runs (2026-06-14)

Two real, logged end-to-end runs of a multi-account fleet job: **plan → parallel dispatch →
synthesize**, with the lead (`alice`) splitting work across two other accounts (`bob`,
`carol`) reviewing *this very codebase*.

- **Run 1 — headless** (`fleet http-control`, operator-driven over localhost HTTP): found
  five genuine quirks in the fleet code, all verified.
- **Run 2 — device + plan mode** (`fleet coordinator` server mode, steered from
  claude.ai/code): turned four of those findings into a 232-line implementation plan written
  to local disk, gated behind plan-mode approval.

Both are below.

---

# Run 1 — headless (`http-control`)

The lead was driven headlessly via `fleet http-control` (the same delegate/synthesize loop
the device-steered `fleet coordinator` runs), and asked to review the codebase by splitting
the work across two accounts. It worked — and the workers surfaced five genuine quirks in
the fleet code, all independently verified below.

---

## The job

```bash
claude-profiles fleet http-control --lead alice        # lead = alice; workers = bob, carol
```

Prompt POSTed to `localhost:8798/control` (abridged):

> **PHASE 1 — PLAN:** write a numbered plan: which account gets which file + the exact
> sub-prompt each will receive.
> **PHASE 2 — DISPATCH:** `delegate_parallel` →
> · `bob`: top 3 reliability/correctness risks in `src/lib/fleet.ts` as
>   `file:line — risk — why`
> · `carol`: same for `src/fleet/orchestrator.ts`
> **PHASE 3 — SYNTHESIZE:** merge into one prioritized top-5, deduped, + an overlap note.

## The result

| Metric | Value |
|---|---|
| Outcome | `ok: true` |
| Wall clock | **51.3 s** (plan + 2 parallel workers + synthesis) |
| Turns | 4 |
| Cost | **$0.363** (across all 3 accounts, subscription OAuth) |
| Coordinator session | `10c7f878-…` (reused on follow-ups via `--resume`) |

**Local proof** (operator-side `state.json` monitor — both workers advanced to the *same*
timestamp in one poll = true concurrent fan-out):

```
[20:54:26] coord=up mcp_children=2 bob=…03:33:38.815Z  carol=…03:33:38.815Z   # baseline at dispatch
[20:55:06] coord=up mcp_children=2 bob=…03:54:39.345Z  carol=…03:54:39.345Z   # both fired together
[20:55:17] coord=up mcp_children=1 …                                                  # http-control MCP child exits
```

### Synthesized answer (verbatim)

> Both workers healthy (bob 5%/wk 4%, carol 7%/wk 1%); ran concurrently. Top 5 by severity:
>
> 1. **`orchestrator.ts:313`** — `void handle(req,res)` swallows rejections — client socket hangs forever; an unhandled rejection can crash the process.
> 2. **`fleet.ts:139`** — timeout only sends `SIGTERM`, no `SIGKILL` escalation — a child ignoring SIGTERM never closes, so `timeoutMs` isn't a hard kill.
> 3. **`orchestrator.ts:297`** — shared mutable `sessionId` raced across concurrent `/control` POSTs — overlapping `--resume` threads corrupt continuity.
> 4. **`fleet.ts:318`** — `Promise.all(tasks.map(resolveConfigDir))` is all-or-nothing — one bad profile rejects the whole batch.
> 5. **`fleet.ts:24`** — `recordUsage` imported but never called — `fleetStatus().usage` never reflects fleet spend.
>
> **Overlap note:** None — disjoint files, six distinct risks, no duplicates; shared theme is unguarded async.

---

## Verification — are the findings real?

Each was checked against the source. **All five are legitimate.**

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `void handle()` can swallow a rejection → hung socket | ✅ Real | `handle()` (orchestrator.ts:316+) has **no outer try/catch**; `await control()` / `await fleetStatus()` throwing escapes the `void`, leaving no response written |
| 2 | Timeout is SIGTERM-only, no SIGKILL escalation | ✅ Real | fleet.ts:140 `child.kill('SIGTERM')` with no follow-up timer |
| 3 | Closure-shared `sessionId` races across concurrent POSTs | ✅ Real | orchestrator.ts:297 `let sessionId` mutated in `control()`; two in-flight `/control` calls interleave resume + assignment |
| 4 | `Promise.all` over config dirs is all-or-nothing | ✅ Real | fleet.ts:318; one invalid profile rejects the entire `runFleet` batch |
| 5 | `recordUsage` imported but never called in fleet.ts | ✅ Real | only call sites are `run.ts` / `statusline.ts`; the fleet delegate path never records usage, so `fleet_status` usage is stale |

That a blind, parallel, two-account review of our own code produced five real, file:line-cited
issues is the strongest possible demonstration that the fan-out does substantive work — not
echo-back theatre.

---

## Quirks found in the harness itself

Beyond the code findings, running the showcase surfaced quirks in the coordinator/fleet
tooling worth improving:

| Quirk | Where | Impact | Suggested fix |
|---|---|---|---|
| **`--port` ignored** | `fleet http-control` | `--port 8799` still bound `:8798`; banner also hard-codes 8798 | thread the port option through to the HTTP server + banner |
| **Concurrent `/control` session race** | `http-control` (finding #3) | two overlapping drivers corrupt the lead's thread | serialize control calls (mutex/queue) or key sessions per-caller |
| **Timeout never hard-kills** | `runFleet` (finding #2) | a wedged worker can hang the batch past `timeoutMs` | SIGTERM then SIGKILL after a grace period |
| **Parallel batch is all-or-nothing on bad profile** | `delegate_parallel` (finding #4) | one typo'd profile drops every valid task | `Promise.allSettled`; fail only the bad task |
| **Fleet spend not recorded** | `fleet_status` (finding #5) | usage-aware routing sees stale numbers for fleet work | call `recordUsage` after each delegate |
| **Headless lead drops the plan narrative** | `http-control` | despite "show your work", only Phase 3 came back — `claude -p` collapses to the final answer | use interactive `fleet coordinator` + plan mode for an approval gate; or ask the lead to return plan+result as structured sections |
| **Transient double MCP child** | observed | each orchestrator spawns its own `fleet --no-http`; `mcp_children` briefly = 2 | benign; note for resource accounting |

> The "dropped plan narrative" quirk is exactly why **plan mode is a `fleet coordinator`
> (device/interactive) feature, not an `http-control` one**: headless `-p` has no approval
> gate, so the plan/execute split only truly exists when a human approves from the device.

---

## Takeaway

- **Works as designed:** one prompt → a plan, a genuine concurrent two-account review, and a
  coherent merged result in ~51 s for ~$0.36, all on subscription OAuth, all local.
- **Self-validating:** the workers found five real bugs in the fleet itself — a high bar for
  "is the delegation actually doing work."
- **Concrete backlog:** the seven quirks above are the punch-list for hardening the fleet
  (top priorities: hard-kill timeout, `allSettled` in parallel, `--port` plumbing, and the
  concurrent-session guard).

---

# Run 2 — device + plan mode (`fleet coordinator`)

The real headline test: `alice` launched as an **official Remote Control** session
(`fleet coordinator --lead alice --server`) and steered entirely from **claude.ai/code**,
using **plan mode** as an approval gate before any delegation.

## The job

Entered from the device in plan mode (abridged):

> Plan a fleet hardening job — **do not delegate yet, just propose**:
> · `bob` → the two `src/lib/fleet.ts` issues (SIGTERM-only timeout; all-or-nothing
>   `Promise.all`)
> · `carol` → the two `src/fleet/orchestrator.ts` issues (`void handle` no try/catch;
>   raced `sessionId`)
> · each worker reads the real file and returns root cause + concrete fix (code sketch) + risk
> · synthesize all four and **write `docs/fleet-hardening-plan.md`**. Wait for my approval.

Reviewed the plan on-device → **approved** → it executed `delegate_parallel` and wrote the file.

## The result

| | |
|---|---|
| Steering | claude.ai/code → local coordinator (PID 55194), server mode |
| Gate | plan mode — proposed, then waited for approval |
| Dispatch | `delegate_parallel` → bob + carol concurrently |
| Artifact | **`docs/fleet-hardening-plan.md`** — 232 lines / 11,298 bytes, on local disk |

**Local proof** (baseline `…03:54:39.345Z`):

```
[21:12:20] baseline           bob=…03:54:39.345Z  carol=…03:54:39.345Z
[21:21:06] coord=up mcp=0      bob=…04:20:24.362Z  carol=…04:20:24.362Z   # both, same poll
                                                                                  # + artifact watcher fired
```

Both workers advanced to an identical timestamp (concurrent), and the plan file appeared on
the machine — a deliverable produced by a device-approved, multi-account fleet job.

## Output quality

The plan wasn't filler — it read the real source and produced implementation-grade fixes:

- **T1** (`orchestrator.ts:312`): wrap `handle()` in `.catch()` with a `headersSent`-guarded
  500 and `res.destroy()` fallback — explicitly to avoid `ERR_HTTP_HEADERS_SENT` on a
  post-`reply()` throw.
- **L1** (`fleet.ts:139`): add a SIGKILL escalation timer after SIGTERM, **cleared in both
  `'error'` and `'close'`** handlers (flagged the recycled-PID hazard if not cleared).
- **L2** (`fleet.ts:318`): `Promise.allSettled` + synthesize a failed `WorkerResult` per bad
  profile — and noted this makes `runFleet` diverge from `dispatch` (one returns `ok:false`,
  the other still throws).
- **T2** (`orchestrator.ts:297`): serialize `control()` via a single-slot promise-chain
  mutex, using `chain = next.catch(()=>{})` so a rejection doesn't poison the chain.

It closed with an implementation checklist and a unit-test strategy (fake-timer SIGKILL test,
mixed valid/unknown-profile `runFleet` test, concurrent-`/control` continuity test).

## Plan-mode behaviour — confirmed

- **Plan-gate held ✅.** The coordinator showed the plan and **refused to auto-run** the
  delegations until the operator approved from the device — verified by the user during this
  run ("it showed the plan and it failed the auto run because we asked it to [wait]"). Only
  after approval did the worker stamps advance. This is the key behavioural win over Run 1:
  headless `-p` has no approval gate and collapses straight to the final answer, whereas
  interactive plan mode surfaces the plan and waits.
- **Plan narrative surfaced ✅.** Unlike Run 1 (which returned only the synthesis), plan mode
  presented the full plan — account split, per-worker sub-prompts, and the write step — for
  review before execution.

## Takeaway

Run 2 closes the loop Run 1 couldn't: a human approving, from a phone/browser, a plan that
then fans out across multiple local accounts and lands a real artifact on disk — the complete
device → plan → multi-agent → local-result path, proven end to end. The artifact itself,
`docs/fleet-hardening-plan.md`, is now the actual backlog for fixing the quirks both runs
surfaced.

---

# Run 3 — implement + verify the plan

The fleet's own backlog, closed. From the remote-controlled `alice` session, all four fixes in
`docs/fleet-hardening-plan.md` were implemented directly in the source (in-session edits, which
is why the worker `lastUsedAt` stamps did not advance — direct edits don't go through the fleet
`markUsed` path). The gates were then run on the machine.

## Gate results

| Gate | Result |
|---|---|
| `npm run build` (tsc) | ✅ clean, no errors |
| `npm run test:unit` | ✅ **548 passed** (was 545 → **+3 new tests**) |
| New coverage | SIGKILL escalation; clean-close never force-kills; unknown-profile isolation |

## Before → after (all four verified in source)

**L1 — hard-kill timeout** (`fleet.ts:139`)
```diff
- child.kill('SIGTERM');                       // sent once, never escalates → wedged child hangs forever
+ child.kill('SIGTERM');
+ killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
+ killTimer.unref?.();
+ // clearTimers() clears BOTH timers on every exit path (avoids SIGKILLing a recycled PID)
```

**L2 — parallel batch resilience** (`fleet.ts:318 → 332`)
```diff
- const dirs = await Promise.all(tasks.map(t => resolveConfigDir(t.profile)));   // 1 bad profile fails ALL
+ const dirs = await Promise.allSettled(tasks.map(t => resolveConfigDir(t.profile)));
+ // rejected slot → self-contained {ok:false, kind:'other', reason:'unknown profile'}, input order kept
```

**T1 — handler can't hang the socket** (`orchestrator.ts:313 → 337`)
```diff
- void handle(req, res);                         // a throw → no response → socket hangs forever
+ handle(req, res).catch(err => {
+   if (!res.headersSent) { res.writeHead(500, …); res.end(…); }   // clean 500
+   else { res.destroy(); }                      // partial reply already sent → abort, no double-send
+ });
```

**T2 — no `sessionId` race** (`orchestrator.ts:297 → 300`)
```diff
- let sessionId; async function control(){ resume: sessionId … sessionId = result.sessionId }  // read→await→write race
+ let chain = Promise.resolve();                 // single-slot promise-chain mutex
+ const next = chain.then(async () => { …atomic read/dispatch/write… });
+ chain = next.catch(() => {});                  // rejection doesn't poison the chain
+ // beyond the plan: /reset also routes through the chain (can't clear sessionId mid-flight)
```

The implementation even improved on the plan in two spots: a named `KILL_GRACE_MS` constant
(vs. an inline magic number) and routing `/reset` through the same mutex.

## Full-loop takeaway

Across three runs the fleet **found its own bugs → planned the fixes behind a device approval
gate → implemented them → passed build + 548 tests with new regression coverage**. Found,
planned, fixed, and verified — dog-fooded end to end.

---

# Run 4 — self-improvement loop (dogfood → fix → repeat)

After the plan was closed, the fleet was pointed back at its own source three more times. Each
cycle: `delegate_parallel` fans two reviewers (`bob`, `carol`) over a fresh set of files →
every finding is spot-checked against source → quick-wins implemented with regression tests →
committed. All workers ran **locally** (the operator-side `state.json` monitor showed each
reviewer's `lastUsedAt` advancing on this machine every round). Every finding across all
rounds was a real bug — no false positives.

| Cycle | Files reviewed | Fixes shipped | Tests |
|---|---|---|---|
| 1 | `state.ts`, `server.ts` | temp-file random token (concurrent-writer collision); HTTP body size cap (413) + malformed-JSON 400 + handler error guard | +5 |
| 2 | `profiles.ts`, `run.ts` | `lstat` so a broken symlink at the target is replaced; atomic shell-rc writes; empty-chain guard on `removeFromChain`; null-safe `process.exit(code ?? 1)` | +1 |
| 3 | `router.ts`, `fleet.ts`, `usage.ts`, `paths.ts`, `chain.ts` | future-only rate-limit `resetAt`; all-deleted chain throws `NO_CHAIN`; clock-regex `(?!\d)` vs. bare epoch; migration re-checks `current` on concurrent rename; chain-delete strips alias from every detected shell rc | +3 |

## Deferred items — closed with TDD

The "larger" items the cycles flagged but deferred were then done **tests-first** (write the
failing test, then implement until green):

| Item | Fix |
|---|---|
| Auto-switch onto an unhealthy account | A proactive switch directive is honoured only when its target is healthy; otherwise it falls through to normal failover. |
| `stream-json` (NDJSON) misclassified | `classifyOutcome` reads the final envelope of multi-object output, so a multi-line error that exits 0 is no longer treated as success. |
| Piped stdin lost on failover | The prompt is buffered once and replayed to every candidate (the first worker would otherwise drain the live stream). |
| `state.json` lost concurrent updates | Read-modify-write runs inside an exclusive lock file — serializes both in-process writers and the fleet's separate `claude -p` worker processes; stale-lock steal + bounded wait so it can't deadlock. |

## Result

**Build clean, 564 unit tests pass** (548 → **+16** across the four commits). The fleet didn't
just fix a one-off backlog — it ran a repeatable find → fix → verify loop on itself and tightened
the same concurrency, parsing, and failover paths it depends on to run.
