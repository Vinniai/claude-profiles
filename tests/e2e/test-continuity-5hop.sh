#!/usr/bin/env bash

# End-to-end test for MULTI-HOP cross-session continuity.
#
# Question under test: when a chain fails over across FIVE different authed
# profiles, one message to the next, is the original context still carried /
# referenced in each new session — or does the 4000-char re-summarisation
# decay older facts after a couple of hops?
#
# It drives the real compiled `claude-profiles _hook <event>` dispatcher exactly
# as Claude Code would (hook JSON on stdin; CLAUDE_PROFILES_CHAIN /
# CLAUDE_CONFIG_DIR / CLAUDE_PROFILES_THREAD in env), across profiles p1..p5.
#
# Fidelity contract: the scripted "assistant" at each hop may ONLY restate facts
# that the SessionStart hook actually delivered to it as additionalContext. It
# parses the carried context, and re-emits a single MEMORY line. If the handoff
# ever drops a fact, the assistant cannot restate it, and every later hop loses
# it too — so real context loss is detected, not papered over.
#
#   hop 1 (p1): USER plants  code=BANANA-7, project=Zephyr, adds item I1
#   hop N (pN): USER adds item I{N}; assistant must recall code+project+I1..I{N}
#               purely from what the previous hop handed off.
#
# A usage-limit line ends each session so pendingFailover is set and the next
# profile's SessionStart injects context — mirroring a real throttle->failover.
#
# No real Claude account or network access is required.

set -u

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
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
mkdir -p "$PROFILES_DIR"
trap 'rm -rf "$TEST_HOME"' EXIT

# Five profiles p1..p5 in chain "fleet".
PROFS=(p1 p2 p3 p4 p5)
{
  echo '{'
  echo '  "profiles": {'
  for i in "${!PROFS[@]}"; do
    p="${PROFS[$i]}"; mkdir -p "$TEST_HOME/.claude-$p"
    sep=','; [ "$i" -eq $((${#PROFS[@]}-1)) ] && sep=''
    echo "    \"$p\": { \"alias\": \"claude-$p\", \"configDir\": \"$TEST_HOME/.claude-$p\", \"priority\": $((i+1)) }$sep"
  done
  echo '  },'
  echo '  "chains": { "fleet": ["p1","p2","p3","p4","p5"] }'
  echo '}'
} > "$PROFILES_DIR/profiles.json"

export HOME="$TEST_HOME"
HANDOFF_FILE="$PROFILES_DIR/handoff/fleet/current.json"

# Extract the most recent "MEMORY :: ..." line from a blob of carried context.
mem_line() { grep -o 'MEMORY :: [^"]*' <<<"$1" | tail -1; }
mem_field() { sed -n "s/.*${2}=\([^|]*\).*/\1/p" <<<"$1" | tr -d ' ' ; }

echo -e "${BLUE}=== claude-profiles 5-hop continuity e2e ===${NC}"
echo "chain: fleet = p1 -> p2 -> p3 -> p4 -> p5"
echo

CODE=""; PROJECT=""; ITEMS=""
declare -a CARRIED

for N in 1 2 3 4 5; do
  P="p$N"; DIR="$TEST_HOME/.claude-$P"
  THREAD="fleet-1"

  # --- SessionStart on this profile: what context did we inherit? ----------
  START_IN="{\"session_id\":\"s$N\",\"source\":\"startup\",\"hook_event_name\":\"SessionStart\"}"
  CARRIED_CTX=$(echo "$START_IN" | CLAUDE_PROFILES_CHAIN=fleet CLAUDE_PROFILES_THREAD="$THREAD" \
    CLAUDE_CONFIG_DIR="$DIR" node "$CLI" _hook SessionStart 2>/dev/null)
  CARRIED[$N]="$CARRIED_CTX"

  if [ "$N" -eq 1 ]; then
    # Fresh start — user plants the durable facts.
    CODE="BANANA-7"; PROJECT="Zephyr"; ITEMS="I1"
    USER_TURN="Remember code=BANANA-7 and project=Zephyr. Add item I1. Recall everything."
  else
    # Recover durable facts strictly from what was handed off.
    ML="$(mem_line "$CARRIED_CTX")"
    CODE="$(mem_field "$ML" code)"
    PROJECT="$(mem_field "$ML" project)"
    INHERITED_ITEMS="$(mem_field "$ML" items)"
    ITEMS="${INHERITED_ITEMS},I$N"
    USER_TURN="Add item I$N. Recall the code, project, and all items so far."
  fi

  # --- Build this session's transcript ------------------------------------
  # Assistant restates ONLY what it now knows (durable facts + running list),
  # then the session is throttled (usage-limit line ends it -> failover).
  T="$TEST_HOME/transcript-$N.jsonl"
  ASSIST="Continuing. MEMORY :: code=$CODE | project=$PROJECT | items=$ITEMS | end. Full context retained."
  {
    echo "{\"type\":\"user\",\"message\":{\"content\":\"$USER_TURN\"}}"
    echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"$ASSIST\"}]}}"
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Claude usage limit reached. Your limit will reset shortly."}]}}'
  } > "$T"

  # --- Stop hook snapshots transcript -> handoff for the next profile ------
  STOP_IN="{\"session_id\":\"s$N\",\"transcript_path\":\"$T\",\"hook_event_name\":\"Stop\"}"
  echo "$STOP_IN" | CLAUDE_PROFILES_CHAIN=fleet CLAUDE_PROFILES_THREAD="$THREAD" \
    CLAUDE_CONFIG_DIR="$DIR" node "$CLI" _hook Stop >/dev/null 2>&1

  CLEN=$(printf '%s' "$CARRIED_CTX" | wc -c | tr -d ' ')
  echo -e "  hop $N on ${YELLOW}$P${NC}: code=${CODE:-∅} project=${PROJECT:-∅} items=${ITEMS:-∅}  (carried ctx: ${CLEN} chars)"
done
echo

# --- Assertions -------------------------------------------------------------

# hop 1 was a fresh start: no inherited context.
if [ -z "${CARRIED[1]}" ]; then
  pass "hop 1 started fresh (no stale context injected)"
else
  fail "hop 1 unexpectedly received context: ${CARRIED[1]}"
fi

# hop 2 inherited the facts planted at hop 1.
if grep -q 'BANANA-7' <<<"${CARRIED[2]}" && grep -q 'Zephyr' <<<"${CARRIED[2]}" && grep -q 'I1' <<<"${CARRIED[2]}"; then
  pass "hop 2 inherited planted code + project + item I1"
else
  fail "hop 2 lost hop-1 context (got: $(mem_line "${CARRIED[2]}"))"
fi

# hop 5 STILL has the hop-1 facts after 4 re-summarisations.
if grep -q 'BANANA-7' <<<"${CARRIED[5]}" && grep -q 'Zephyr' <<<"${CARRIED[5]}"; then
  pass "hop 5 STILL carries the code+project planted 4 hops earlier"
else
  fail "hop 5 lost the original planted facts (got: $(mem_line "${CARRIED[5]}"))"
fi

# hop 5 has the full accumulated item list I1..I4 from the prior hops.
miss=""
for it in I1 I2 I3 I4; do grep -q "$it" <<<"${CARRIED[5]}" || miss="$miss $it"; done
if [ -z "$miss" ]; then
  pass "hop 5 accumulated every prior item (I1..I4)"
else
  fail "hop 5 missing accumulated items:$miss (got: $(mem_line "${CARRIED[5]}"))"
fi

# The continuation instruction is present so the model won't greet/restart.
if grep -qi 'continuing an in-progress conversation' <<<"${CARRIED[5]}" \
   && grep -qi 'do not greet' <<<"${CARRIED[5]}"; then
  pass "each new session is told to resume, not restart"
else
  fail "continuation framing missing from injected context"
fi

# Final handoff record points at the last profile in the path.
if node -e "const h=require('$HANDOFF_FILE'); process.exit(h.lastProfile==='p5'?0:1)" 2>/dev/null; then
  pass "handoff record tracks the active profile across the path (lastProfile=p5)"
else
  fail "handoff record did not track the final profile"
fi

echo
echo -e "${BLUE}=== Results: $TESTS_PASSED/$TESTS_RUN passed ===${NC}"
[ "$TESTS_FAILED" -eq 0 ] && exit 0 || exit 1
