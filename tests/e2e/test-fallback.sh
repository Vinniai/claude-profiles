#!/usr/bin/env bash

# End-to-end failover test for `claude-profiles run`.
#
# Uses a MOCK `claude` binary (injected via CLAUDE_PROFILES_CLAUDE_BIN) that
# fails the first profile with a usage-limit error (exit 1) and succeeds on the
# second. Asserts that:
#   1. `run --chain default` falls over and returns the second profile's output.
#   2. A cooldown is recorded for the first profile in state.json.
#   3. `chain status` then reports the first profile as cooling down.
#
# No real Claude account or network access is required.

set -u

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

pass() { TESTS_RUN=$((TESTS_RUN + 1)); TESTS_PASSED=$((TESTS_PASSED + 1)); echo -e "${GREEN}✓${NC} $1"; }
fail() { TESTS_RUN=$((TESTS_RUN + 1)); TESTS_FAILED=$((TESTS_FAILED + 1)); echo -e "${RED}✗${NC} $1"; }

# Resolve repo root (this script lives in tests/e2e/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$REPO_ROOT/dist/index.js"

if [ ! -f "$CLI" ]; then
  echo -e "${YELLOW}Building first (dist/index.js missing)…${NC}"
  (cd "$REPO_ROOT" && npm run build >/dev/null 2>&1)
fi
if [ ! -f "$CLI" ]; then
  echo -e "${RED}Build failed; cannot run e2e test.${NC}"
  exit 1
fi

# Isolated HOME so we never touch the user's real profiles/state.
TEST_HOME="$(mktemp -d)"
PROFILES_DIR="$TEST_HOME/.claude/.claude-profiles"
mkdir -p "$PROFILES_DIR"
mkdir -p "$TEST_HOME/.claude-a" "$TEST_HOME/.claude-b"

cleanup() { rm -rf "$TEST_HOME" "$MOCK_DIR"; }
trap cleanup EXIT

# --- Mock claude binary -----------------------------------------------------
# First invocation: emit a usage-limit JSON envelope + exit 1.
# Second onward: emit success + exit 0. A counter file tracks invocations.
MOCK_DIR="$(mktemp -d)"
MOCK_CLAUDE="$MOCK_DIR/claude"
COUNTER_FILE="$MOCK_DIR/calls"
echo 0 > "$COUNTER_FILE"

cat > "$MOCK_CLAUDE" <<EOF
#!/usr/bin/env bash
n=\$(cat "$COUNTER_FILE")
n=\$((n + 1))
echo \$n > "$COUNTER_FILE"
# Record which profile (CLAUDE_CONFIG_DIR) was used, for debugging.
echo "\$CLAUDE_CONFIG_DIR" >> "$MOCK_DIR/dirs"
if [ "\$n" -eq 1 ]; then
  echo '{"type":"result","is_error":true,"result":"Claude usage limit reached. Please try again later."}'
  exit 1
fi
echo '{"type":"result","is_error":false,"result":"hello from the fallback profile"}'
exit 0
EOF
chmod +x "$MOCK_CLAUDE"

# --- Seed profiles + a default chain ---------------------------------------
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
export CLAUDE_PROFILES_CLAUDE_BIN="$MOCK_CLAUDE"

echo "=== claude-profiles failover e2e ==="

# --- Test 1: run fails over a → b and returns b's output --------------------
OUTPUT="$(node "$CLI" run --chain default -- -p "hi" 2>/tmp/cp-e2e-stderr)"
RUN_EXIT=$?

if echo "$OUTPUT" | grep -q "hello from the fallback profile"; then
  pass "run returned the fallback profile's output"
else
  fail "run did not return the fallback output (got: $OUTPUT)"
fi

if [ "$RUN_EXIT" -eq 0 ]; then
  pass "run exited 0 after a successful fallback"
else
  fail "run exited $RUN_EXIT (expected 0)"
fi

CALLS="$(cat "$COUNTER_FILE")"
if [ "$CALLS" -eq 2 ]; then
  pass "mock claude was invoked twice (a failed, b succeeded)"
else
  fail "mock claude was invoked $CALLS time(s), expected 2"
fi

# --- Test 2: a cooldown was recorded for profile "a" ------------------------
STATE_FILE="$PROFILES_DIR/state.json"
if [ -f "$STATE_FILE" ] && grep -q '"cooldownUntil"' "$STATE_FILE" && \
   node -e "const s=require('$STATE_FILE'); process.exit(s.profiles && s.profiles.a && s.profiles.a.cooldownUntil ? 0 : 1)"; then
  pass "a cooldown was recorded for profile \"a\""
else
  fail "no cooldown recorded for profile \"a\" in state.json"
fi

# --- Test 3: chain status reports "a" cooling down --------------------------
# --offline: this test exercises cooldown reporting, not the live login probe
# (the mock claude emits result-JSON, not auth-JSON, and counts every call).
STATUS="$(node "$CLI" chain status --offline 2>&1)"
if echo "$STATUS" | grep -qi "cooling down"; then
  pass "chain status reports a profile cooling down"
else
  fail "chain status did not report a cooling-down profile"
fi

# --- Test 4: chain reset clears the cooldown --------------------------------
node "$CLI" chain reset a >/dev/null 2>&1
if node -e "const s=require('$STATE_FILE'); process.exit(s.profiles && s.profiles.a ? 1 : 0)"; then
  pass "chain reset cleared the runtime state for \"a\""
else
  fail "chain reset did not clear the runtime state for \"a\""
fi

echo
echo "=== Results: $TESTS_PASSED/$TESTS_RUN passed ==="
[ "$TESTS_FAILED" -eq 0 ] && exit 0 || exit 1
