# Fleet Hardening Plan

A review surfaced four actionable robustness defects in the fleet runtime — two in
the worker spawn layer (`src/lib/fleet.ts`) and two in the remote-control orchestrator
(`src/fleet/orchestrator.ts`). Each was diagnosed against the real source by a
dedicated worker account; this document orders them by blast radius and records the
root cause, concrete fix, and risk for each.

Implementation order is chosen so the safest, most-enabling change lands first:

1. **T1** — orchestrator handler try/catch (prevents hung sockets)
2. **L1** — SIGTERM → SIGKILL escalation (stops hung workers)
3. **L2** — per-profile config-dir isolation (batch resilience)
4. **T2** — serialize `/control` session state (correctness under concurrency)

---

## 1. T1 — `handle()` has no try/catch; a throw hangs the socket

**File:** `src/fleet/orchestrator.ts:312-314`

**Root cause:** The `createServer` callback fires `void handle(req, res)` with no
`.catch()` and no surrounding try/catch. `handle()` is async and does real work that
can reject before any reply is written: `await fleetStatus()` (line 325), the
`for await (const c of req)` body read (line 337), and `await control(...)` (line 351),
which calls `dispatch()` and can throw. On rejection the promise is discarded (`void`),
so `res` is never written or ended — the socket hangs until the client/keep-alive
timeout. No 500, no close.

**Concrete fix:** Catch on the dispatch wrapper and send a 500 only if headers
haven't already been flushed:

```ts
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`control handler error: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    } else {
      res.destroy(); // partial response already on the wire — abort, don't double-send
    }
  });
});
```

**Risk / tradeoffs:**
- **Double-send:** `reply()` (line 319) calls `writeHead`+`end`. A throw *after* a
  successful `reply()` must not write again — the `headersSent` guard handles this,
  falling back to `res.destroy()`. Without it you'd get
  `ERR_STREAM_WRITE_AFTER_END` / `ERR_HTTP_HEADERS_SENT`.
- **Partial write:** if a reply was interrupted mid-body (rare here, since `reply` is
  a synchronous `writeHead`+`end`), `destroy()` yields a truncated response rather
  than a clean 500 — acceptable, since the alternative is a hang.
- Don't echo `err.message` into the body (info leak); the sketch returns a generic
  message and logs the specifics.

---

## 2. L1 — timeout sends SIGTERM but never escalates to SIGKILL

**File:** `src/lib/fleet.ts:139-143`

**Root cause:** The timeout handler calls `child.kill('SIGTERM')` once and appends a
stderr note, but never follows up. If the child traps, ignores, or is slow on SIGTERM
(e.g. a wedged `claude` process or a stuck network read), it stays alive, the
`'close'` handler never fires, and the `captureWorker` promise — and the `await` in
`runWorker` — hangs indefinitely past `timeoutMs`. The `timer.unref?.()` only stops
the timer from holding the event loop open; it does nothing to force the child down.

**Concrete fix:** Arm a second escalation timer when SIGTERM fires, and clear it on
every exit path:

```ts
let killTimer: NodeJS.Timeout | undefined;
if (timeoutMs && timeoutMs > 0) {
  timer = setTimeout(() => {
    child.kill('SIGTERM');
    stderr += `\n[fleet] worker timed out after ${timeoutMs}ms`;
    // Escalate if SIGTERM is ignored/slow.
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref?.();
  }, timeoutMs);
  timer.unref?.();
}
```

Then clear `killTimer` alongside `timer` in *both* terminal handlers:

```ts
child.on('error', (err) => { if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); /* … */ });
child.on('close', (code) => { if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); resolve({ exitCode: code, stdout, stderr }); });
```

**Risk / tradeoffs:**
- The 2000ms grace is a new magic number. On close the escalation timer **must** be
  cleared, or it could SIGKILL a new, unrelated PID if the OS recycled it — clearing
  it in both `'close'` and `'error'` prevents that.
- `killTimer.unref?.()` is required for symmetry; otherwise a pending 2s escalation
  could briefly keep the event loop alive (minor, matches existing `timer.unref` intent).
- SIGKILL still resolves via the normal `'close'` path (signal-terminated children
  emit `close` with `code: null`), so there's no double-resolve and no return-shape
  change — `exitCode` is already `number | null`, and `classifyOutcome` behavior is
  unchanged.

---

## 3. L2 — `runFleet` config-dir resolution is all-or-nothing

**File:** `src/lib/fleet.ts:318`

**Root cause:** `const dirs = await Promise.all(tasks.map((t) => resolveConfigDir(t.profile)))`
rejects the entire batch the moment any single `resolveConfigDir` throws
`PROFILE_NOT_FOUND` (`fleet.ts:284`). One typo'd or unknown profile aborts `runFleet`
before any worker spawns, so valid tasks never run and the caller gets a thrown error
instead of a `WorkerResult[]`.

**Concrete fix:** Isolate per-task resolution with `Promise.allSettled`, turning a
rejected resolve into a failed `WorkerResult` in place (preserving input order)
rather than spawning:

```ts
const settled = await Promise.allSettled(tasks.map((t) => resolveConfigDir(t.profile)));

const results: WorkerResult[] = new Array(tasks.length);
let cursor = 0;
async function pump(): Promise<void> {
  while (cursor < tasks.length) {
    const i = cursor++;
    const d = settled[i];
    if (d.status === 'rejected') {
      const message = d.reason instanceof Error ? d.reason.message : String(d.reason);
      results[i] = {
        profile: tasks[i].profile, ok: false, kind: 'other', text: '',
        outcome: { ok: false, kind: 'other', resetAt: null, reason: 'unknown profile', raw: message },
        error: message,
      };
      continue;
    }
    results[i] = await runWorker(tasks[i], d.value, { spawnImpl: opts.spawnImpl, now });
  }
}
```

**Risk / tradeoffs:**
- **Behavior change callers depend on:** today a bad profile *throws* out of
  `runFleet`; after the fix it returns a `WorkerResult` with `ok:false, kind:'other'`.
  Callers relying on the throw to hard-fail the batch must now inspect results. This
  matches `runWorker`'s existing spawn-failure shape (`fleet.ts:202-210`), so it's
  consistent — but `dispatch` (`fleet.ts:299`) still throws on a bad profile, so the
  two entry points now diverge. Worth a doc note.
- `applyWorkerEffects` runs over these synthesized results too — fine, since
  `kind:'other'` hits the no-op `default` branch (`fleet.ts:259-261`), so no state is
  written for unknown profiles.
- `resolveConfigDir` calls `loadProfiles()` once per task (N reads). Already true with
  `Promise.all`; `allSettled` doesn't worsen it, but since you're here, hoisting a
  single `loadProfiles()` and matching each profile against it would cut N→1 and make
  "unknown profile" a cheap synchronous check.

---

## 4. T2 — closure-shared `sessionId` races across concurrent `/control` POSTs

**File:** `src/fleet/orchestrator.ts:297, 300-309`

**Root cause:** `let sessionId` is captured by the `control()` closure. `control()` does
a non-atomic read→dispatch→write: `resume: sessionId` (line 305) is read, then
`await dispatch(...)` yields the event loop, then `sessionId = result.sessionId`
(line 308) writes back. Two overlapping `POST /control` requests (line 351) both read
the *same* pre-dispatch `sessionId`, fork two threads off one parent, and the
later-resolving write clobbers the earlier — orchestrator continuity races. `/reset`
(line 330) and the `reset` flag (line 301) can also null `sessionId` mid-flight.

**Concrete fix:** Serialize `control()` through a promise chain (single-slot async
mutex) so read/dispatch/write is atomic per call:

```ts
let sessionId: string | undefined;
let chain: Promise<unknown> = Promise.resolve();

function control(prompt: string, reset: boolean): Promise<WorkerResult> {
  const next = chain.then(async () => {
    if (reset) sessionId = undefined;
    const result = await dispatch({ profile: lead, prompt, resume: sessionId, extraArgs });
    if (result.sessionId) sessionId = result.sessionId;
    return result;
  });
  // keep the chain alive even if this call rejects, and don't leak the rejection
  chain = next.catch(() => {});
  return next;
}
```

**Risk / tradeoffs:**
- **Throughput:** fully serializes all control turns — concurrent callers now queue.
  Correct for a single shared conversation thread (parallel turns on one session were
  never coherent), but it removes concurrency. Acceptable given the semantics.
- **Reset-vs-inflight ordering:** the synchronous `POST /reset` handler (line 330)
  still mutates `sessionId` *outside* the chain, so a reset can land between a queued
  call's enqueue and its execution. For consistency, route `/reset` through the same
  chain (enqueue a reset task) rather than writing `sessionId` directly.
- **Chain error isolation:** `chain = next.catch(() => {})` is required — assigning
  the raw `next` back to `chain` would make every subsequent call inherit the
  rejection and fire an unhandled-rejection warning. The caller still gets the real
  rejection via the returned `next`.
- **Unbounded queue:** a slow/hung `dispatch` blocks all queued calls with no timeout;
  consider a per-call timeout if hangs are a concern (overlaps with L1's escalation).

---

## Implementation checklist

- [ ] **T1** — wrap `handle(req, res)` in `.catch()` with a `headersSent`-guarded 500 / `res.destroy()` fallback (`orchestrator.ts:312`).
- [ ] **L1** — add `killTimer` SIGKILL escalation in `captureWorker`; clear it in both `'error'` and `'close'` handlers (`fleet.ts:139`).
- [ ] **L2** — switch `runFleet` to `Promise.allSettled`; synthesize a failed `WorkerResult` for rejected profiles (`fleet.ts:318`). Note the `runFleet`-vs-`dispatch` divergence.
- [ ] **T2** — serialize `control()` via a promise chain; optionally route `/reset` through the same chain (`orchestrator.ts:297`).

## Verification

- **Unit (`tests/unit/lib/fleet.test.ts`):**
  - L1: inject a `spawnImpl` whose fake child ignores SIGTERM; assert SIGKILL is sent
    after the grace window and the promise resolves (use fake timers).
  - L2: `runFleet` with one valid + one unknown profile; assert the valid task runs
    and the unknown returns `ok:false, kind:'other'` in the correct slot — no throw.
- **Orchestrator:**
  - T1: stub `control()`/`fleetStatus()` to throw; `POST /control` (or `GET /status`)
    must return 500, not hang. Add coverage under a new orchestrator test if absent.
  - T2: fire several concurrent `POST /control` requests at a running control server;
    assert each dispatch resumes the prior session in order (no clobbered/forked
    `sessionId`). A manual smoke test: start `startRemoteControl`, send 3 overlapping
    `curl` POSTs to `/control`, confirm continuity in the `orchestratorSession` field.
- Run the repo's lint/format/typecheck on changed files before committing.
