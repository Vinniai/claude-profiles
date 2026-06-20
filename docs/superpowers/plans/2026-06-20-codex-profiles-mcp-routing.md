# Codex Profiles and MCP Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend claude-profiles so isolated Claude and Codex accounts can be addressed through one profile registry and routed by the fleet MCP with explicit fallbacks or task-specific assignments.

**Architecture:** Preserve existing profiles as Claude profiles by default, then add a provider discriminator and provider-specific runtime adapters. A Codex account profile owns an isolated `CODEX_HOME` with file-backed credentials, while an optional native Codex config profile selects model/reasoning settings inside that home. The fleet MCP accepts explicit profiles, chains, or configured task routes and retries only failures classified as rate-limit, authentication, or transient server errors.

**Tech Stack:** TypeScript, Commander, Model Context Protocol SDK, Vitest, Claude Code CLI, Codex CLI.

---

### Task 1: Provider-aware profile model

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/profiles.ts`
- Test: `tests/unit/lib/profiles.test.ts`

- [x] Add `provider: "claude" | "codex"` with legacy profiles defaulting to Claude.
- [x] Add optional `configProfile` and `taskTypes` fields.
- [x] Create Codex profiles under `~/.codex-<name>` and write `config.toml` with `cli_auth_credentials_store = "file"`.
- [x] Share Codex-safe instruction and extension directories without sharing `auth.json`.
- [x] Generate provider-correct shell aliases.
- [x] Run the profile unit tests; expect PASS.

### Task 2: Provider-aware profile CLI

**Files:**
- Modify: `src/commands/profile.ts`
- Test: `tests/unit/commands/commands.test.ts`

- [x] Add `--provider claude|codex`, `--config-profile`, and task assignment input to profile creation/set commands.
- [x] Run `claude /login` for Claude profiles and `codex login` with isolated `CODEX_HOME` for Codex profiles.
- [x] Show provider and task assignments in profile listings.
- [x] Keep existing commands and aliases backward compatible.
- [x] Run command tests; expect PASS.

### Task 3: Codex fleet worker adapter

**Files:**
- Modify: `src/lib/fleet.ts`
- Create: `src/lib/codex-output.ts`
- Test: `tests/unit/lib/fleet.test.ts`
- Test: `tests/unit/lib/codex-output.test.ts`

- [x] Build `codex exec --json` and `codex exec resume --json` argument lists.
- [x] Launch Codex workers with `CODEX_HOME` and no inherited `OPENAI_API_KEY` or `CODEX_API_KEY`.
- [x] Parse JSONL `thread.started`, final `agent_message`, `turn.completed`, `turn.failed`, and `error` events.
- [x] Normalize Codex results into the existing `WorkerResult` contract.
- [x] Reuse health cooldown/auth effects across providers.
- [x] Run fleet and parser tests; expect PASS.

### Task 4: MCP routing and failover

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/fleet.ts`
- Modify: `src/fleet/server.ts`
- Modify: `src/commands/fleet.ts`
- Test: `tests/unit/lib/fleet.test.ts`
- Test: `tests/unit/fleet/server.test.ts`

- [x] Add `taskRouting` mappings from task type to ordered profile names.
- [x] Accept exactly one selector among `profile`, `chain`, and `taskType`.
- [x] Add `fallback` and `fallbackProfiles` controls.
- [x] Select healthy candidates first and retry only classified failover failures.
- [x] Return attempted profile names in MCP results.
- [x] Apply the same routed behavior to parallel MCP tasks with bounded concurrency.
- [x] Run fleet MCP tests; expect PASS.

### Task 5: Codex MCP installation and documentation

**Files:**
- Modify: `src/commands/fleet.ts`
- Modify: `README.md`
- Test: `tests/unit/commands/commands.test.ts`

- [x] Add a command that registers the fleet stdio server in a selected Codex profile home.
- [x] Document account profiles versus native Codex config profiles.
- [x] Document explicit delegation, task routing, chains, and fallback behavior.
- [x] Include setup examples for multiple Codex logins and a Codex orchestrator.
- [x] Run `npm run build` and `npm run test:unit`; expect both to pass.

### Task 6: Provider models, skills, and cross-provider handoff

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/fleet.ts`
- Modify: `src/fleet/server.ts`
- Modify: `src/commands/fleet.ts`
- Modify: `README.md`
- Test: `tests/unit/lib/fleet.test.ts`
- Test: `tests/unit/fleet/server.test.ts`

- [x] Support `models.claude` and `models.codex` per task and per task route.
- [x] Support common `skills` and provider-specific `providerSkills`.
- [x] Carry explicit `handoffContext` into fresh fallback sessions.
- [x] Never forward account/provider-local session IDs across fallback boundaries.
- [x] Return the attempted profile/model/skill trace to the calling session.
- [x] Document and test an image-generation route using the Codex `imagegen` skill.
