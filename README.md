# CLAUDE-PROFILES

**Run multiple Claude Code OAuth accounts side by side, and fall back automatically when one hits a usage limit, auth, or server error.**

> A fork of [jean-claude](https://github.com/MikeVeerman/jean-claude) by Mike Veerman, extended with multi-account routing and automatic failover.

## Why?

You've got more than one Claude account — Alice and Bob, work and personal, or several Max subscriptions across a team. Each account has its **own** session limit (the rolling 5-hour window) and its own weekly cap. Used one at a time, you burn one account to zero while the others sit idle — then get blocked mid-task.

**claude-profiles pools them.** Each profile is an isolated Claude Code config directory with its *own* OAuth login (`CLAUDE_CONFIG_DIR`), so every account stays authenticated at once. Group them into a **chain** and one command treats the whole set as a single, larger budget — **balancing** new work across accounts so no one limit gets exhausted first, and **failing over** the instant an account hits a usage-limit (429), server (5xx/overloaded), or auth/expired-token error.

### How it balances and optimises your session limits

Three accounts, three separate limits, become one pooled budget you route intelligently:

```
   alice (max-20x)      bob (max-5x)       carol (pro)
   ████████████ 100%    ██████░░░░ 60%     ██░░░░░░ 25%      ← each account's
        │                    │                   │             session budget left
        └────────────────────┼───────────────────┘
                             ▼
                   ┌───────────────────┐
                   │   claude-profiles  │   one command · one pooled budget
                   └─────────┬─────────┘
                             ▼
        picks the right account for THIS run, by strategy:

   --most-remaining → alice   (most session budget left — spread the load)
   --balanced       → bob      (round-robin — even wear across accounts)
   --weighted       → alice    (biggest plan does the heavy lifting)
   default/--failover → alice  (priority order, then fall through on limit)
```

When the chosen account throttles, the run **doesn't stop** — it re-routes to the next healthy account and records a cooldown so the drained one is skipped until its limit resets:

```
  run ─▶ alice  ✗ usage limit (cooldown 5h) ─▶ bob  ✓ served
                 │                                   │
                 └─ context handed off ──────────────┘   same conversation,
                                                          new account, no restart
```

The net effect: you get the **combined** session hours of every account, automatically drawing from whichever one has headroom — instead of babysitting logins. It still does everything the original did too: manage profiles, share config via symlinks, and sync across machines with Git.

> 📊 See the [live showcase](docs/showcase.html), [strategy deep-dive](docs/strategic-routing.html), and [routing log & labels](docs/routing-log-and-labels.html) for the full visual walkthrough.

## Quick Start

```bash
# Install globally…
npm install -g @vinniai/claude-profiles

# …or run without installing
npx @vinniai/claude-profiles init

# Initialize
claude-profiles init

# Create a profile per account — `create` is top-level (no nested `profile`)
claude-profiles create alice
claude-profiles create bob

# Log each one in (opens `claude /login` against that profile)
claude-profiles login alice
claude-profiles login bob

# Group them into a fallback chain (in priority order)
claude-profiles chain create default --profiles alice,bob

# Run with automatic failover — installs a `claude-default` alias too
claude-default -p "summarize this repo"
```

> `create` and `login` are root-level shortcuts. The longer `claude-profiles profile create` / `profile login` still work, and `profile list/set/delete/refresh` live under `profile`.

### One-shot setup (copy & paste)

Set up two accounts and a chain in a single block — edit the names, paste, and go:

```bash
claude-profiles init
for p in alice bob; do
  claude-profiles create "$p" --yes
  claude-profiles login "$p"     # opens claude /login for each account
done
claude-profiles chain create default --profiles alice,bob
claude-default -p "say hi"        # runs through the chain with failover
```

> **Copy it to your clipboard to share** with a teammate setting up their own multi-account chain:
>
> ```bash
> # macOS
> pbcopy < <(curl -fsSL https://raw.githubusercontent.com/Vinniai/claude-profiles/main/scripts/multi-account-setup.sh)
> # Linux (X11 / Wayland)
> xclip -sel clip  < scripts/multi-account-setup.sh   # or:  wl-copy < scripts/multi-account-setup.sh
> ```

## Authentication & multi-account OAuth

Each profile is an isolated Claude Code config directory (`~/.claude-<name>/`) with its **own** OAuth login, stored in its own `.credentials.json`. That isolation is what lets several accounts stay authenticated and run at once.

### Authenticate each account

```bash
# Runs `claude /login` against the profile's config dir — log in, then exit.
claude-profiles login alice
claude-profiles login bob
```

`login` is just a convenience for:

```bash
CLAUDE_CONFIG_DIR=~/.claude-alice claude /login
```

### Reuse an existing logged-in session (no re-login)

Already logged in on your main `~/.claude`? Seed a profile with that session instead of authenticating again — copy the credentials into the new profile's config dir:

```bash
claude-profiles create alice --yes
cp ~/.claude/.credentials.json ~/.claude-alice/.credentials.json   # reuse the existing session
claude-profiles chain status                                       # 'alice' shows healthy, already authed
```

> The same trick imports any existing `~/.claude-*` account you authenticated by hand — point the `cp` at its `.credentials.json`. Everything else (settings, hooks, agents, skills) is already shared via symlinks, so only the credentials need to move.

### Re-authenticate when a profile needs auth

When an account's token expires, failover flags it `needs auth` (visible in `chain status`). Re-auth and clear the flag:

```bash
claude-profiles login alice     # log back in
claude-profiles chain reset alice       # clear the needs-auth flag
```

### Share the whole setup (copy to clipboard)

The repo ships [`scripts/multi-account-setup.sh`](scripts/multi-account-setup.sh) — a single, parameterized block that creates + authenticates each account and builds the chain. Copy it to your clipboard to hand to a teammate:

```bash
# macOS
pbcopy < scripts/multi-account-setup.sh
# Linux
xclip -selection clipboard < scripts/multi-account-setup.sh    # X11
wl-copy < scripts/multi-account-setup.sh                       # Wayland
```

They paste it into a terminal (optionally overriding the accounts) and they're done:

```bash
PROFILES="alice bob carol" CHAIN=team bash multi-account-setup.sh
```

## Multi-account fallback

### Chains

A **chain** is an ordered list of profiles tried in turn. `chain create` also installs a `claude-<chain>` shell alias that routes through the failover engine.

```bash
# Create a chain (alice tried first, then bob, then carol)
claude-profiles chain create default --profiles alice,bob,carol

# List chains
claude-profiles chain list

# Edit a chain
claude-profiles chain add default dave
claude-profiles chain remove default carol

# Health of every profile (healthy / cooling down / needs auth)
claude-profiles chain status

# Clear cooldowns / needs-auth flags (one profile, or all)
claude-profiles chain reset alice
claude-profiles chain reset

# Delete a chain (and its alias)
claude-profiles chain delete default
```

### Running

```bash
# Headless (auto-detected when -p/--print is present): full auto-retry across the chain
claude-profiles run --chain default -- -p "say hi"

# Or via the generated alias
claude-default -- -p "say hi"

# A single profile, no fallback
claude-profiles run --profile alice -- -p "say hi"

# Interactive (the TUI): launches the first healthy profile in the chain
claude-profiles run --chain default

# Force a mode
claude-profiles run --chain default --headless -- -p "..."
claude-profiles run --chain default --interactive
```

Everything after `--` is forwarded verbatim to `claude`.

### Shorthand: skip `run --…`

The profile/chain name can come **first**, so the common cases read naturally. The
leading token(s) are rewritten to the equivalent `run` invocation:

```bash
claude-profiles alice -- -p "hi"                 # → run --profile alice   (one account, no fallback)
claude-profiles default -- -p "hi"               # → run --chain default   (a saved chain)
claude-profiles alice bob -- -p "hi"             # → run --profiles alice,bob   (ad-hoc chain, failover)
claude-profiles alice bob --balanced -p "hi"     # round-robin across the two, even split
claude-profiles alice:3 bob:1 -- -p "hi"         # weighted split 3:1 (ratio) — implies --weighted
claude-profiles alice=50 bob=50 -- -p "hi"       # weighted split 50/50 (percent)
```

Rules: one profile with no weight keeps single-account semantics (no fallback); two or
more names — or any inline weight — become an **ad-hoc chain** (nothing saved). A run
flag (`--balanced`, `--weighted`, `--min-session 20`, …) placed *before* your `claude`
args is applied to the routing; everything else is forwarded to `claude`. Normal claude
flags pass straight through (`--dangerously-skip-permissions`, `--model`, `-p`, …).

### How failover works

| Mode | Behavior |
|------|----------|
| **Headless** (`-p`/`--print`) | Each profile is tried in order. On a **usage-limit (429)**, **server error (5xx/overloaded)**, or **auth/expired token**, a cooldown is recorded and the next profile is tried. A *generic* crash (any other non-zero exit) is surfaced immediately — no silent reroute. If every profile is exhausted you get `ALL_PROFILES_EXHAUSTED` summarizing each failure. |
| **Interactive** (the TUI, default) | The *first healthy* (non-cooled-down) profile in the chain is launched. A supervisor relaunches the next healthy account if `claude` exits after a limit, restoring context (see [Cross-session continuity](#cross-session-continuity-handoff)). If all are cooling down, the first is launched anyway (its limit may have reset). |

Cooldowns: rate limits use the reset time from the error when available, else **1 hour**; server errors use **2 minutes**; auth failures flag the profile as *needs auth* until you re-run `login`. Health lives in `state.json`, kept separate from `profiles.json` so concurrent runs don't collide.

> Need a custom `claude` binary (or to run the e2e test)? Set `CLAUDE_PROFILES_CLAUDE_BIN`.

### Routing history & labels

Every routing move is recorded so you can tell a switch you **chose** from one a limit **forced** — at a glance, and across sessions. There are four kinds in two headline categories:

| Glyph | Kind | Category | Means |
|-------|------|----------|-------|
| `◆` | `manual` | **deliberate** | You moved work on purpose (via the [channel](#channel-mid-run-switching) `switch_account`). |
| `▲` | `limit` / `auth` / `server` | **auto-failover** | The Claude CLI returned a 429 / expired-auth / 5xx and the router rerouted itself. |
| `▸` | `launch` | launch | The first, strategy-driven account a run started on. |
| `×` | `exhausted` | exhausted | No healthy account was left to try. |

These labels show up in three places:

```bash
# 1. Live in the terminal — the failover card colors its marker by category
#    (cyan ◆ deliberate vs yellow ▲ automatic).

# 2. When you query state — `chain status` adds a `via` badge on a cooling account:
claude-profiles chain status
#   ■ alice
#     status   cooling down — 2h10m left — usage limit reached
#     via      ▲ auto-failover (limit)

# 3. The durable routing log — directions over time, recalled across sessions:
claude-profiles chain log                 # last 20 events, newest last
claude-profiles chain log --chain default # only one chain
claude-profiles chain log --limit 50      # more history
claude-profiles chain log --clear         # erase it
```

The log lives in its own `routing-log.json`, so it **survives `chain reset`** (which only clears cooldowns) and is written by any process — the `run` supervisor in one session, the channel sidecar in another. That shared, durable file is what lets the history be recalled across sessions. See [`docs/routing-log-and-labels.html`](docs/routing-log-and-labels.html) for an annotated visual tour.

### Routing strategy & usage budgets

By default a chain is tried in order (`priority`). You can change how the router picks among *healthy* accounts, and track each account's session/weekly budget:

```bash
claude-profiles strategy                  # show / set the routing strategy
                                          #   priority · round-robin · least-used · most-remaining · weighted
claude-profiles usage                     # inspect per-profile session / weekly budgets
```

**Persistent vs one-shot.** `strategy set` saves a default (globally or per chain);
the same choices are available as one-shot flags on `run` (and the shorthand), which
override the saved default for that invocation only:

```bash
claude-profiles strategy set round-robin            # persistent default
claude-profiles run --chain default --balanced -- … # just this run
# shorthand flags: --failover --balanced --weighted --least-used --most-remaining
# one-shot policy gates: --min-session <pct>  --min-weekly <pct>
```

**Plan tiers.** Tag each account with its subscription so the router understands
relative capacity instead of you hand-tuning weights:

```bash
claude-profiles profile set alice --plan max-20x
claude-profiles profile set bob   --plan max-5x
claude-profiles profile set carol --plan pro
```

`plan` feeds three things automatically: the default **`weighted`** share (a `max-20x`
gets ~4× a `max-5x`), the **absolute** headroom compared by `most-remaining` (a 20× at
50% outranks a 5× at 50%), and the implicit **big-first** order when no explicit
`priority`/chain order is set (most-headroom account leads, smallest is the backstop).
Set `--weight` explicitly to override the plan-derived weight; `--priority` to override
the order.

**Sticky sessions.** Load-spreading strategies (`round-robin`, `weighted`) only choose
at the *start* of a fresh interactive session. A **continuation** — including after a
compaction — stays pinned to the account it started on, so the conversation never
fragments across accounts. You only leave that account when it actually hits a limit,
at which point [continuity](#cross-session-continuity-handoff) restores context onto the
next one.

### A real fleet (6 accounts) end-to-end

A team running six separate Claude logins — two `max-20x` heavy hitters, two `max-5x`
dailies, and two `pro` backstops. Each is its own OAuth account in its own
`~/.claude-<name>/` dir.

```bash
# 1. Create + log in each account (own browser login per account)
for p in alice bob carol dave erin frank; do
  claude-profiles create "$p"
  claude-profiles login  "$p"     # opens that account's OAuth flow
done

# 2. Tag each with its plan so the router knows relative capacity
claude-profiles profile set alice --plan max-20x   # heavy hitters
claude-profiles profile set bob   --plan max-20x
claude-profiles profile set carol --plan max-5x    # dailies
claude-profiles profile set dave  --plan max-5x
claude-profiles profile set erin  --plan pro       # backstops
claude-profiles profile set frank --plan pro

# 3. Build one chain over all six (installs the `claude-fleet` alias)
claude-profiles chain create fleet --profiles alice,bob,carol,dave,erin,frank
```

`chain status` shows the whole fleet at a glance — health, plan, and cooldowns:

```text
claude-profiles chain status --chain fleet
  ■ alice   healthy   max-20x
  ■ bob     healthy   max-20x
  ■ carol   healthy   max-5x
  ■ dave    cooling down — 41m left — usage limit reached   via ▲ auto-failover (limit)
  ■ erin    healthy   pro
  ■ frank   needs auth                                       via ▲ auto-failover (auth)
```

Now route across all six. The same chain answers to every form:

```bash
# Failover order (priority): alice → bob → carol → dave → erin → frank
claude-profiles run --chain fleet -- -p "summarize this repo"
claude-fleet -- -p "summarize this repo"          # generated alias, identical

# Spread load instead of draining the first account — capacity-aware:
# alice/bob (20×) take the lion's share, erin/frank (pro) the least.
claude-profiles run --chain fleet --weighted -- -p "..."
claude-profiles run --chain fleet --balanced -- -p "..."   # even round-robin
claude-profiles run --chain fleet --most-remaining -- -p "..."  # whoever has the most budget left

# Keep the heavy accounts in reserve — only use them above a budget floor:
claude-profiles run --chain fleet --min-session 25 -- -p "..."

# Ad-hoc subset, no saved chain — just name the accounts inline:
claude-profiles alice bob carol -- -p "hi"        # → 3-account ad-hoc chain
claude-profiles alice:3 bob:2 carol:1 -- -p "hi"  # weighted 3:2:1 across three
```

When `alice` hits its limit mid-run, the router records its cooldown and rolls to
`bob`, then `carol`, and so on — you keep working without touching the CLI. With six
accounts the chain effectively pools all their windows: someone is almost always
healthy.

### Channel: mid-run switching

The optional **Channel** sidecar is a Claude Code MCP server that pushes account-health events into a live session and accepts a deliberate mid-run account switch (a `switch_account` tool + HTTP control face). It's what stamps a move as `◆ manual` rather than `▲ auto-failover`.

```bash
claude-profiles channel                   # start the channel (stdio MCP + 127.0.0.1 control face on :8799)

# Deliberately move the current thread to another account mid-run:
curl -s -XPOST localhost:8799/switch -d '{"target":"bob","reason":"draining alice before reset"}'
```

The launcher picks up the requested switch when the `claude` session next exits, relaunching on the chosen account with context restored.

## Cross-session continuity (handoff)

Interactive is the **default, standard run mode** — `claude-profiles run --chain default` (and the generated `claude-<chain>` alias) launches the normal `claude` TUI, not headless `-p`. Because a long-lived TUI can't be swapped mid-conversation, failover here means **relaunch-with-context**: when a session ends after a limit, the next launch picks a healthy account and **continues the conversation** rather than starting over.

This is powered by a **shared directory** and a set of **auto-installed hooks**:

- **Shared store:** `~/.claude/.claude-profiles/handoff/<chain>/current.json` — lives outside any single profile, so context is portable across accounts. It holds the chain's "thread": last profile, a running summary, the transcript reference, and a `pendingFailover` flag.
- **Hooks** (added to your shared `~/.claude/settings.json`, tagged and removable):
  - `Stop` / `SessionEnd` / `PreCompact` → snapshot the conversation to the shared store; if the last turn hit a limit/auth error, record the active profile's cooldown and set `pendingFailover`.
  - `SessionStart` → **only after a failover**, inject the prior summary via `additionalContext` so the new account picks up seamlessly, then clear the flag.

Continuity kicks in **only after a failover** — a clean session ends with no `pendingFailover`, so a fresh launch never re-injects last conversation's context. Use `run --new` to force a fresh thread.

The hooks **no-op unless a session was launched through a chain** (they key off `CLAUDE_PROFILES_CHAIN`), so your normal `claude` usage is completely unaffected. They're installed automatically on `chain create` / first chain `run`; manage them explicitly with:

```bash
claude-profiles handoff status        # hooks installed? stored threads?
claude-profiles handoff enable         # install the hooks
claude-profiles handoff disable        # remove them
claude-profiles handoff clear [chain]  # drop stored context (one chain, or all)
```

## Profiles

Profiles let you run multiple Claude Code configurations side by side — each with its own authentication.

```bash
# Create a profile (interactive — prompts for sharing preferences)
claude-profiles create alice

# Create non-interactively, with metadata and chain membership
claude-profiles create alice --yes --shell .zshrc \
  --description "Alice's Max account" --priority 1 --chain default

# Authenticate a profile (runs `claude /login` against its config dir)
claude-profiles login alice

# List your profiles
claude-profiles profile list

# Launch Claude Code with a single profile
claude-alice

# Re-create symlinks if something breaks
claude-profiles profile refresh alice

# Delete a profile
claude-profiles profile delete alice
```

### How profiles work

Your main `~/.claude/` stays the source of truth. Profile directories (`~/.claude-<name>/`) are lightweight — they hold their own credentials and symlink back to your shared files:

| Always shared (symlinked) | Optionally shared | Profile-specific       |
|---------------------------|-------------------|------------------------|
| `settings.json`           | `CLAUDE.md`       | Authentication/session |
| `hooks/`                  | `statusline.sh`   |                        |
| `agents/`                 |                   |                        |
| `skills/`                 |                   |                        |
| `plugins/`                |                   |                        |
| `keybindings.json`        |                   |                        |

During profile creation, you're prompted whether to share `CLAUDE.md` and `statusline.sh` or keep them independent per profile. You can also use flags:

```bash
# Share both
claude-profiles create alice --share-claude-md --share-statusline

# Keep both independent
claude-profiles create alice --no-share-claude-md --no-share-statusline
```

Change a setting or add a hook in your main config, and all profiles see it immediately.

Profiles work independently of syncing — you can use them without setting up Git.

## Syncing

Syncing is optional and uses Git to keep your configuration in sync across machines.

### What gets synced?

- `CLAUDE.md` — Your custom instructions
- `settings.json` — Your preferences
- `hooks/` — Your automation scripts
- `skills/` — Your custom skills
- `agents/` — Your custom agents
- `keybindings.json` — Your keyboard shortcuts
- `statusline.sh` — Your statusline configuration
- Profile and chain definitions — So they carry over to other machines

### Commands

```bash
claude-profiles sync setup    # Set up syncing (during init or later)
claude-profiles sync push     # Push your config to Git
claude-profiles sync pull     # Pull config on another machine
claude-profiles sync status   # Check sync status
```

### Typical workflow

```bash
# Machine 1: Initialize and push
claude-profiles init
claude-profiles create alice --yes --shell .zshrc
claude-profiles sync push

# Machine 2: Initialize, pull, and go
claude-profiles init --sync --url git@github.com:you/claude-config.git
claude-profiles sync pull
claude-alice  # Profile alias is ready
```

## Command Reference

| Command | Description |
|---------|-------------|
| `claude-profiles init` | Initialize on this machine |
| `claude-profiles init --sync --url <repo>` | Initialize with Git syncing |
| `claude-profiles create <name>` | Create a new profile (`--description`, `--priority`, `--chain`) — also `profile create` |
| `claude-profiles login <name>` | Authenticate a profile's OAuth account — also `profile login` |
| `claude-profiles profile list` | List all profiles |
| `claude-profiles profile delete <name>` | Delete a profile |
| `claude-profiles profile refresh <name>` | Refresh profile symlinks |
| `claude-profiles chain create <name> --profiles a,b,c` | Create a fallback chain + alias |
| `claude-profiles chain list` | List chains |
| `claude-profiles chain add/remove <name> <profile>` | Edit a chain |
| `claude-profiles chain status` | Show per-profile health + usage, with a `via` failover label |
| `claude-profiles chain log [--chain <n>] [--limit <n>] [--clear]` | Routing history — launches, deliberate switches, failovers |
| `claude-profiles chain reset [profile]` | Clear cooldowns / needs-auth |
| `claude-profiles chain delete <name>` | Delete a chain |
| `claude-profiles run --chain <name> -- <claude args>` | Run with failover (`--new` for a fresh thread) |
| `claude-profiles run --profile <name> -- <claude args>` | Run a single profile |
| `claude-profiles strategy` | Show / set how the router picks among healthy profiles |
| `claude-profiles usage` | Inspect / set per-profile session & weekly budgets |
| `claude-profiles channel` | Run the Channel sidecar (health events + mid-run switching) |
| `claude-profiles handoff status / enable / disable / clear` | Manage cross-session continuity |
| `claude-profiles sync push / pull / status / setup` | Git sync |

### Environment variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CONFIG_DIR` | Isolates a profile's OAuth login (set automatically per profile) |
| `CLAUDE_PROFILES_CLAUDE_BIN` | Override the `claude` binary (tests / custom installs) |
| `CLAUDE_PROFILES_CHAIN`, `CLAUDE_PROFILES_THREAD` | Set by the supervisor when launching; read by the continuity hooks (internal) |

> An existing `~/.claude/.jean-claude` state directory is migrated automatically to `~/.claude/.claude-profiles` on first run.

## Development

### Running Tests

```bash
npm test                 # unit + integration
npm run test:unit        # fast unit tests
npm run test:unit:watch  # watch mode
npm run test:coverage    # coverage report
npm run test:integration # integration tests

# Failover + continuity end-to-end (mock claude, no account needed)
bash tests/e2e/test-fallback.sh
bash tests/e2e/test-handoff.sh
```

#### Unit Tests

Fast, isolated tests for core logic:
- Profile creation, symlinks, and duplicate prevention
- Error/limit classification (`claude-errors`) and router ordering/failover
- Interactive supervisor relaunch logic
- Chain CRUD and alias generation
- Continuity: handoff records, transcript summarisation, hook install/merge
- File sync and metadata operations
- Error handling and types

#### Integration & E2E Tests

- **Integration**: init, profiles, sync setup/push/pull/status, multi-machine convergence, edge cases.
- **`tests/e2e/test-fallback.sh`**: injects a mock `claude` that fails the first profile with a usage limit and succeeds on the second, then asserts the chain failed over, recorded a cooldown, and `chain status` reflects it.

See [tests/README.md](tests/README.md) for more details.

---

*Forked from jean-claude — named after the famous Belgian martial artist and philosopher, because your config deserves to do the splits between profiles, accounts, and machines.*
