#!/usr/bin/env bash

# End-to-end test for cross-session continuity (handoff) hooks.
#
# Drives the hidden `claude-profiles _hook <event>` dispatcher exactly as Claude
# Code would — piping hook JSON on stdin with CLAUDE_PROFILES_CHAIN /
# CLAUDE_CONFIG_DIR set — and asserts:
#   1. `handoff enable` installs hooks into settings.json.
#   2. A Stop hook seeing a usage-limit transcript records a cooldown for the
#      active profile and writes a handoff record with pendingFailover.
#   3. A SessionStart hook emits additionalContext and clears pendingFailover.
#   4. `handoff clear` removes the stored context.
#
# No real Claude account or network access is required.

set -u

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
TESTS_RUN=0; TESTS_PASSED=0; TESTS_FAILED=0
pass() { TESTS_RUN=$((TESTS_RUN+1)); TESTS_PASSED=$((TESTS_PASSED+1)); echo -e "${GREEN}✓${NC} $1"; }
fail() { TESTS_RUN=$((TESTS_RUN+1)); TESTS_FAILED=$((TESTS_FAILED+1)); echo -e "${RED}✗${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$REPO_ROOT/dist/index.js"

if [ ! -f "$CLI" ]; then
  echo -e "${YELLOW}Building first…${NC}"; (cd "$REPO_ROOT" && npm run build >/dev/null 2>&1)
fi
[ -f "$CLI" ] || { echo -e "${RED}Build failed.${NC}"; exit 1; }

TEST_HOME="$(mktemp -d)"
PROFILES_DIR="$TEST_HOME/.claude/.claude-profiles"
SETTINGS="$TEST_HOME/.claude/settings.json"
mkdir -p "$PROFILES_DIR" "$TEST_HOME/.claude-a" "$TEST_HOME/.claude-b"
trap 'rm -rf "$TEST_HOME"' EXIT

cat > "$PROFILES_DIR/profiles.json" <<EOF
{
  "profiles": {
    "a": { "alias": "claude-a", "configDir": "$TEST_HOME/.claude-a", "priority": 1 },
    "b": { "alias": "claude-b", "configDir": "$TEST_HOME/.claude-b", "priority": 2 }
  },
  "chains": { "default": ["a", "b"] }
}
EOF

export HOME="$TEST_HOME"
CP() { node "$CLI" "$@"; }

echo "=== claude-profiles handoff/continuity e2e ==="

# --- Test 1: enable installs hooks ------------------------------------------
CP handoff enable >/dev/null 2>&1
if [ -f "$SETTINGS" ] && grep -q '_hook SessionStart' "$SETTINGS" && grep -q '_hook Stop' "$SETTINGS"; then
  pass "handoff enable installed continuity hooks"
else
  fail "handoff enable did not install hooks"
fi

# --- Test 2: a Stop hook on a usage-limit transcript records cooldown + handoff
TRANSCRIPT="$TEST_HOME/transcript.jsonl"
{
  echo '{"type":"user","message":{"content":"Please refactor this module."}}'
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Claude usage limit reached. Your limit will reset later."}]}}'
} > "$TRANSCRIPT"

STOP_INPUT=$(cat <<EOF
{"session_id":"sess-1","transcript_path":"$TRANSCRIPT","hook_event_name":"Stop"}
EOF
)
echo "$STOP_INPUT" | CLAUDE_PROFILES_CHAIN=default CLAUDE_PROFILES_THREAD=default-1 \
  CLAUDE_CONFIG_DIR="$TEST_HOME/.claude-a" node "$CLI" _hook Stop >/dev/null 2>&1

STATE_FILE="$PROFILES_DIR/state.json"
HANDOFF_FILE="$PROFILES_DIR/handoff/default/current.json"

if node -e "const s=require('$STATE_FILE'); process.exit(s.profiles?.a?.cooldownUntil ? 0 : 1)" 2>/dev/null; then
  pass "Stop hook recorded a cooldown for the active profile \"a\""
else
  fail "Stop hook did not record a cooldown for \"a\""
fi

if node -e "const h=require('$HANDOFF_FILE'); process.exit(h.pendingFailover && h.lastProfile==='a' && /refactor/i.test(h.summary||'') ? 0 : 1)" 2>/dev/null; then
  pass "Stop hook wrote a handoff record (pendingFailover + summary + lastProfile)"
else
  fail "Stop hook did not write a correct handoff record"
fi

# --- Test 3: SessionStart injects context and clears the failover flag -------
START_INPUT='{"session_id":"sess-2","source":"startup","hook_event_name":"SessionStart"}'
START_OUT=$(echo "$START_INPUT" | CLAUDE_PROFILES_CHAIN=default CLAUDE_PROFILES_THREAD=default-1 \
  CLAUDE_CONFIG_DIR="$TEST_HOME/.claude-b" node "$CLI" _hook SessionStart 2>/dev/null)

if echo "$START_OUT" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const o=JSON.parse(d);
    process.exit(o.hookSpecificOutput?.hookEventName==='SessionStart' &&
      /continuing/i.test(o.hookSpecificOutput?.additionalContext||'') ? 0 : 1);
  }catch{process.exit(1)}
});" 2>/dev/null; then
  pass "SessionStart emitted additionalContext to continue the conversation"
else
  fail "SessionStart did not emit continuation context (got: $START_OUT)"
fi

if node -e "const h=require('$HANDOFF_FILE'); process.exit(h.pendingFailover ? 1 : 0)" 2>/dev/null; then
  pass "SessionStart cleared the pendingFailover flag"
else
  fail "SessionStart did not clear pendingFailover"
fi

# --- Test 4: a no-chain session is a strict no-op ---------------------------
NOOP_OUT=$(echo "$START_INPUT" | CLAUDE_CONFIG_DIR="$TEST_HOME/.claude-b" \
  node "$CLI" _hook SessionStart 2>/dev/null)
if [ -z "$NOOP_OUT" ]; then
  pass "hook is a no-op when not launched through a chain"
else
  fail "hook emitted output without a chain (got: $NOOP_OUT)"
fi

# --- Test 5: handoff clear removes stored context ---------------------------
CP handoff clear default >/dev/null 2>&1
if [ ! -f "$HANDOFF_FILE" ]; then
  pass "handoff clear removed the stored context"
else
  fail "handoff clear did not remove stored context"
fi

echo
echo "=== Results: $TESTS_PASSED/$TESTS_RUN passed ==="
[ "$TESTS_FAILED" -eq 0 ] && exit 0 || exit 1
