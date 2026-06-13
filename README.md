# CLAUDE-PROFILES

**Run multiple Claude Code OAuth accounts side by side, and fall back automatically when one hits a usage limit, auth, or server error.**

> A fork of [jean-claude](https://github.com/MikeVeerman/jean-claude) by Mike Veerman, extended with multi-account routing and automatic failover.

## Why?

You've got more than one Claude account — work and personal, or several Max subscriptions across a team. Each has its own usage limit. When one runs out mid-session, you're stuck switching logins by hand.

**claude-profiles fixes that.** Each profile is an isolated Claude Code config directory with its *own* OAuth login (`CLAUDE_CONFIG_DIR`), so multiple accounts can be authenticated and used at once. Group them into an ordered **chain**, and `claude-profiles run` automatically routes to the next account when one returns a usage-limit (429), server (5xx/overloaded), or auth/expired-token error — recording a cooldown so it isn't retried until the limit resets.

It still does everything the original did: manage profiles, share config via symlinks, and sync across machines with Git.

## Quick Start

```bash
# Install globally
npm install -g claude-profiles

# Initialize
claude-profiles init

# Create profiles for each account (one OAuth login per profile)
claude-profiles profile create work
claude-profiles profile create personal

# Log each one in
claude-profiles profile login work
claude-profiles profile login personal

# Group them into a fallback chain (in priority order)
claude-profiles chain create default --profiles work,personal

# Run with automatic failover — installs a `claude-default` alias too
claude-default -p "summarize this repo"
```

## Multi-account fallback

### Chains

A **chain** is an ordered list of profiles tried in turn. `chain create` also installs a `claude-<chain>` shell alias that routes through the failover engine.

```bash
# Create a chain (work tried first, then personal, then backup)
claude-profiles chain create default --profiles work,personal,backup

# List chains
claude-profiles chain list

# Edit a chain
claude-profiles chain add default another-account
claude-profiles chain remove default backup

# Health of every profile (healthy / cooling down / needs auth)
claude-profiles chain status

# Clear cooldowns / needs-auth flags (one profile, or all)
claude-profiles chain reset work
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
claude-profiles run --profile work -- -p "say hi"

# Interactive (the TUI): launches the first healthy profile in the chain
claude-profiles run --chain default

# Force a mode
claude-profiles run --chain default --headless -- -p "..."
claude-profiles run --chain default --interactive
```

Everything after `--` is forwarded verbatim to `claude`.

### How failover works

| Mode | Behavior |
|------|----------|
| **Headless** (`-p`/`--print`) | Each profile is tried in order. On a **usage-limit (429)**, **server error (5xx/overloaded)**, or **auth/expired token**, a cooldown is recorded and the next profile is tried. A *generic* crash (any other non-zero exit) is surfaced immediately — no silent reroute. If every profile is exhausted you get `ALL_PROFILES_EXHAUSTED` summarizing each failure. |
| **Interactive** (the TUI) | A long-lived session can't be rerouted mid-flight, so the *first healthy* (non-cooled-down) profile in the chain is chosen at launch. If all are cooling down, the first is launched anyway (its limit may have reset). |

Cooldowns: rate limits use the reset time from the error when available, else **1 hour**; server errors use **2 minutes**; auth failures flag the profile as *needs auth* until you re-run `profile login`. Health lives in `state.json`, kept separate from `profiles.json` so concurrent runs don't collide.

> Need a custom `claude` binary (or to run the e2e test)? Set `CLAUDE_PROFILES_CLAUDE_BIN`.

## Profiles

Profiles let you run multiple Claude Code configurations side by side — each with its own authentication.

```bash
# Create a profile (interactive — prompts for sharing preferences)
claude-profiles profile create work

# Create non-interactively, with metadata and chain membership
claude-profiles profile create work --yes --shell .zshrc \
  --description "Work Max account" --priority 1 --chain default

# Authenticate a profile (runs `claude /login` against its config dir)
claude-profiles profile login work

# List your profiles
claude-profiles profile list

# Launch Claude Code with a single profile
claude-work

# Re-create symlinks if something breaks
claude-profiles profile refresh work

# Delete a profile
claude-profiles profile delete work
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
claude-profiles profile create work --share-claude-md --share-statusline

# Keep both independent
claude-profiles profile create work --no-share-claude-md --no-share-statusline
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
claude-profiles profile create work --yes --shell .zshrc
claude-profiles sync push

# Machine 2: Initialize, pull, and go
claude-profiles init --sync --url git@github.com:you/claude-config.git
claude-profiles sync pull
claude-work  # Profile alias is ready
```

## Command Reference

| Command | Description |
|---------|-------------|
| `claude-profiles init` | Initialize on this machine |
| `claude-profiles init --sync --url <repo>` | Initialize with Git syncing |
| `claude-profiles profile create <name>` | Create a new profile (`--description`, `--priority`, `--chain`) |
| `claude-profiles profile login <name>` | Authenticate a profile's OAuth account |
| `claude-profiles profile list` | List all profiles |
| `claude-profiles profile delete <name>` | Delete a profile |
| `claude-profiles profile refresh <name>` | Refresh profile symlinks |
| `claude-profiles chain create <name> --profiles a,b,c` | Create a fallback chain + alias |
| `claude-profiles chain list` | List chains |
| `claude-profiles chain add/remove <name> <profile>` | Edit a chain |
| `claude-profiles chain status` | Show per-profile health |
| `claude-profiles chain reset [profile]` | Clear cooldowns / needs-auth |
| `claude-profiles chain delete <name>` | Delete a chain |
| `claude-profiles run --chain <name> -- <claude args>` | Run with failover |
| `claude-profiles run --profile <name> -- <claude args>` | Run a single profile |
| `claude-profiles sync push / pull / status / setup` | Git sync |

> The legacy `jean-claude` command is still installed as an alias of `claude-profiles`, and an existing `~/.claude/.jean-claude` state directory is migrated automatically on first run.

## Development

### Running Tests

```bash
npm test                 # unit + integration
npm run test:unit        # fast unit tests
npm run test:unit:watch  # watch mode
npm run test:coverage    # coverage report
npm run test:integration # integration tests

# Failover end-to-end (mock claude, no account needed)
bash tests/e2e/test-fallback.sh
```

#### Unit Tests

Fast, isolated tests for core logic:
- Profile creation, symlinks, and duplicate prevention
- Error/limit classification (`claude-errors`) and router ordering/failover
- Chain CRUD and alias generation
- File sync and metadata operations
- Error handling and types

#### Integration & E2E Tests

- **Integration**: init, profiles, sync setup/push/pull/status, multi-machine convergence, edge cases.
- **`tests/e2e/test-fallback.sh`**: injects a mock `claude` that fails the first profile with a usage limit and succeeds on the second, then asserts the chain failed over, recorded a cooldown, and `chain status` reflects it.

See [tests/README.md](tests/README.md) for more details.

---

*Forked from jean-claude — named after the famous Belgian martial artist and philosopher, because your config deserves to do the splits between profiles, accounts, and machines.*
