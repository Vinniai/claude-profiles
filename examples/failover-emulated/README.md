# Example: failover, proven against an emulated Anthropic API

This example shows — and *animates* — how `claude-profiles` automatically fails
over from one OAuth account to the next when an account hits its usage limit,
with the **successful** call served by a live, production-fidelity
[`agent-emulate`](https://www.npmjs.com/package/agent-emulate) Anthropic API. No
real Claude account and no network access are required.

It has two halves:

1. **An end-to-end test** you can run — [`tests/e2e/test-fallback-emulated.sh`](../../tests/e2e/test-fallback-emulated.sh).
2. **A [hyperframes](https://www.npmjs.com/package/hyperframes) video composition**
   (`index.html`) that narrates the exact same flow as a 1920×1080 animation.

---

## How the pieces fit

```
claude-profiles run --chain default -- -p "say hi in 3 words"
        │
        ▼
   profile a  ──►  mock claude  ──►  exit 1 + "usage limit reached"
        │                              (the ONLY injected fault)
        │   classify → rate_limit → ▲ auto-failover (limit), cooldown a → 1h
        ▼
   profile b  ──►  mock claude  ──►  POST http://localhost:4099/v1/messages
                                     x-api-key: test_token_admin
                                          │
                                          ▼
                              agent-emulate  ──►  200 OK, real Messages JSON
        │
        ▼
   exit 0, served by b   ·   routing-log.json records ▸ launch + ▲ limit
```

### Why the fault is injected at the CLI boundary

`claude-profiles` decides whether to reroute by **classifying the `claude` CLI's
exit code + stdout/stderr text** — not HTTP responses. The emulator faithfully
returns `200` (with a key) or `401` (without one); it never returns a `429`
usage-limit. So the test injects the *one* fault that drives failover — a
usage-limit envelope + `exit 1` — at exactly the layer the supervisor inspects,
via a mock `claude` wired in through `CLAUDE_PROFILES_CLAUDE_BIN`.

### Why the success path uses the emulator

Everything *after* the reroute is real: profile `b`'s mock `claude` forwards the
prompt to `agent-emulate`'s Anthropic service and gets back a genuine
Messages-API-shaped response (`id`, `role`, `content[].text`, `stop_reason`,
`usage`). That keeps the success path production-fidelity instead of a hand-typed
stub — the half of the flow that *shouldn't* be faked, isn't.

---

## Run the end-to-end test

```bash
# from the repo root
./tests/e2e/test-fallback-emulated.sh
```

The script boots `agent-emulate --service anthropic --port 4099` for you (or
reuses one already listening), runs everything in an isolated `$HOME`, and asserts:

1. `run --chain default` falls over `a → b` and returns the **emulator's** text.
2. `run` exits `0` after the successful fallback.
3. A cooldown is recorded for `a` in `state.json`.
4. The routing log captured a `limit` (auto-failover) event.
5. `chain status` reports `a` cooling down.

It skips cleanly (exit 0) if `npx`/network is unavailable, and only kills the
emulator if it was the one that started it.

Boot the emulator yourself to poke at it:

```bash
npm run emulator          # npx agent-emulate --service anthropic --port 4099
curl -s localhost:4099/v1/models -H "x-api-key: test_token_admin"
```

---

## The hyperframes video

`index.html` is a self-contained [hyperframes](https://www.npmjs.com/package/hyperframes)
composition — a GSAP-driven 1920×1080 timeline, no external image assets — that
walks through the same five beats: the chain, the request landing on `a`, the
limit + `▲ auto-failover (limit)` reroute, `b` proxying to the live emulated
`/v1/messages`, and the recalled routing log (`▸ launch`, `▲ limit`).

```bash
cd examples/failover-emulated

npm run dev        # live preview in the browser
npm run check      # hyperframes lint && validate && inspect
npm run render     # → renders/failover-emulated.mp4 + .jpg poster
```

The glyph vocabulary matches the CLI and `docs/routing-log-and-labels.html`:

| glyph | meaning |
| ----- | ------- |
| `▸` | launch |
| `◆` | deliberate / manual switch |
| `▲` | automatic failover (limit / auth / server) |
| `×` | exhausted |

---

## Where the MCP fits: mid-run switching

The test above exercises the **headless** path (`run -p …`), which retries across
the whole chain automatically. The same routing vocabulary powers the
**channel MCP** sidecar (`src/channel/server.ts`) used for *interactive*,
mid-session switching: when you deliberately hop accounts during a live session
it's logged as `◆ manual switch` (a *deliberate* category), visibly distinct from
the `▲ auto-failover` the supervisor records here. Both append to the same shared
`routing-log.json`, which is why `claude-profiles chain log` can recall the full
history — automatic and deliberate, headless and interactive — across sessions.
