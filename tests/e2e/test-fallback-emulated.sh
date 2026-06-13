#!/usr/bin/env bash

# End-to-end failover test backed by a REAL emulated Anthropic API.
#
# This is the production-fidelity sibling of test-fallback.sh. Instead of a
# fully canned success path, the *successful* profile proxies to a live
# `agent-emulate` Anthropic service (npx agent-emulate --service anthropic),
# which speaks the real Messages API shape (POST /v1/messages, x-api-key auth,
# Anthropic-shaped JSON response). Only the *failure* (usage-limit) is injected
# at the CLI boundary — because the emulator returns 200/401, never 429 — which
# is exactly where claude-profiles classifies outcomes.
#
# Flow:
#   profile "a"  -> mock claude emits a usage-limit envelope + exit 1   (cooldown)
#   profile "b"  -> mock claude POSTs the prompt to the emulator and
#                   re-wraps the real response as claude --output-format json
#
# Asserts:
#   1. run --chain default falls over a -> b and returns the EMULATOR's text.
#   2. A cooldown is recorded for "a" in state.json.
#   3. The routing log captured a `limit` failover event.
#   4. chain status reports "a" cooling down with the auto-failover label.
#
# Requires network/npx to fetch agent-emulate. Skips cleanly if unavailable.

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
skip() { echo -e "${YELLOW}∼ skip:${NC} $1"; }

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

command -v curl >/dev/null 2>&1 || { skip "curl not available"; exit 0; }
command -v npx  >/dev/null 2>&1 || { skip "npx not available";  exit 0; }

# --- Boot the emulated Anthropic API ----------------------------------------
EMU_PORT="${EMU_PORT:-4099}"
EMU_URL="http://localhost:$EMU_PORT"
EMU_KEY="test_token_admin"
EMU_LOG="$(mktemp)"
EMU_PID=""

emu_up() { curl -sf -o /dev/null "$EMU_URL/v1/models" -H "x-api-key: $EMU_KEY" 2>/dev/null; }

if emu_up; then
  echo "Reusing agent-emulate already listening on $EMU_URL"
else
  echo "Booting agent-emulate anthropic on $EMU_URL …"
  PORT="$EMU_PORT" npx -y agent-emulate --service anthropic --port "$EMU_PORT" >"$EMU_LOG" 2>&1 &
  EMU_PID=$!
  for _ in $(seq 1 60); do emu_up && break; sleep 0.5; done
  if ! emu_up; then
    skip "agent-emulate did not come up (network/npx?). Log: $(tail -3 "$EMU_LOG" | tr '\n' ' ')"
    [ -n "$EMU_PID" ] && kill "$EMU_PID" 2>/dev/null
    exit 0
  fi
fi

# --- Isolated HOME + mock claude --------------------------------------------
TEST_HOME="$(mktemp -d)"
PROFILES_DIR="$TEST_HOME/.claude/.claude-profiles"
mkdir -p "$PROFILES_DIR" "$TEST_HOME/.claude-a" "$TEST_HOME/.claude-b"
MOCK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_HOME" "$MOCK_DIR" "$EMU_LOG"
  # Only kill the emulator if WE started it.
  [ -n "$EMU_PID" ] && kill "$EMU_PID" 2>/dev/null
}
trap cleanup EXIT

MOCK_CLAUDE="$MOCK_DIR/claude"
COUNTER_FILE="$MOCK_DIR/calls"
echo 0 > "$COUNTER_FILE"

# Profile "a"'s configDir ends in .claude-a; that call fails. Any other proxies
# to the emulator. The mock pulls the prompt from its argv (-p "<prompt>").
cat > "$MOCK_CLAUDE" <<EOF
#!/usr/bin/env bash
n=\$(cat "$COUNTER_FILE"); n=\$((n + 1)); echo \$n > "$COUNTER_FILE"
echo "\$CLAUDE_CONFIG_DIR" >> "$MOCK_DIR/dirs"

# Extract the prompt that followed -p / --print.
prompt="hello"
prev=""
for arg in "\$@"; do
  case "\$prev" in -p|--print) prompt="\$arg" ;; esac
  prev="\$arg"
done

case "\$CLAUDE_CONFIG_DIR" in
  *".claude-a")
    echo '{"type":"result","is_error":true,"result":"Claude usage limit reached. Please try again later."}'
    exit 1
    ;;
esac

# Success path: ask the REAL emulated Anthropic Messages API.
body=\$(printf '{"model":"claude-sonnet-4","max_tokens":64,"messages":[{"role":"user","content":%s}]}' \
  "\$(printf '%s' "\$prompt" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | awk '{printf "\"%s\"", \$0}')")
resp=\$(curl -s "$EMU_URL/v1/messages" \
  -H "x-api-key: $EMU_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d "\$body")
# Pull the assistant text out of the Anthropic-shaped response.
text=\$(printf '%s' "\$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.content&&j.content[0]&&j.content[0].text)||"")}catch{process.stdout.write("")}})')
node -e 'const t=process.argv[1];process.stdout.write(JSON.stringify({type:"result",is_error:false,result:t}))' "\$text"
exit 0
EOF
chmod +x "$MOCK_CLAUDE"

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

echo "=== claude-profiles failover e2e (emulated Anthropic API) ==="

# --- Test 1: failover returns the EMULATOR's text ---------------------------
OUTPUT="$(node "$CLI" run --chain default -- -p "say hi in 3 words" 2>/tmp/cp-e2e-emu-stderr)"
RUN_EXIT=$?

if echo "$OUTPUT" | grep -qi "agent-emulate Anthropic emulator"; then
  pass "run returned the live emulator's response after failover"
else
  fail "run did not return the emulator response (got: $OUTPUT)"
fi

if [ "$RUN_EXIT" -eq 0 ]; then
  pass "run exited 0 after a successful fallback"
else
  fail "run exited $RUN_EXIT (expected 0)"
fi

CALLS="$(cat "$COUNTER_FILE")"
if [ "$CALLS" -eq 2 ]; then
  pass "mock claude was invoked twice (a failed, b proxied to emulator)"
else
  fail "mock claude was invoked $CALLS time(s), expected 2"
fi

# --- Test 2: cooldown recorded for "a" --------------------------------------
STATE_FILE="$PROFILES_DIR/state.json"
if [ -f "$STATE_FILE" ] && \
   node -e "const s=require('$STATE_FILE'); process.exit(s.profiles && s.profiles.a && s.profiles.a.cooldownUntil ? 0 : 1)"; then
  pass "a cooldown was recorded for profile \"a\""
else
  fail "no cooldown recorded for profile \"a\" in state.json"
fi

# --- Test 3: routing log captured a `limit` failover event ------------------
LOG_FILE="$PROFILES_DIR/routing-log.json"
if [ -f "$LOG_FILE" ] && node -e "const f=require('$LOG_FILE'); const e=f.events||[]; process.exit(e.some(x=>x.kind==='limit')?0:1)"; then
  pass "routing log recorded a limit (auto-failover) event"
else
  fail "routing log did not record a limit event ($LOG_FILE)"
fi

# --- Test 4: chain status shows "a" cooling down ----------------------------
STATUS="$(node "$CLI" chain status 2>&1)"
if echo "$STATUS" | grep -qi "cooling down"; then
  pass "chain status reports a profile cooling down"
else
  fail "chain status did not report a cooling-down profile"
fi

echo
echo "=== Results: $TESTS_PASSED/$TESTS_RUN passed ==="
[ "$TESTS_FAILED" -eq 0 ] && exit 0 || exit 1
