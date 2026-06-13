#!/usr/bin/env bash
#
# claude-profiles — shareable multi-account OAuth setup.
#
# Copy this to a teammate (or pipe it to your clipboard) so they can stand up
# the same multi-account fallback chain in one go:
#
#   macOS:   pbcopy   < scripts/multi-account-setup.sh
#   X11:     xclip -sel clip < scripts/multi-account-setup.sh
#   Wayland: wl-copy  < scripts/multi-account-setup.sh
#
# Override the accounts and chain name with env vars:
#   PROFILES="work personal backup" CHAIN=team ./scripts/multi-account-setup.sh
#
set -euo pipefail

PROFILES="${PROFILES:-work personal}"   # space-separated profile names, in fallback order
CHAIN="${CHAIN:-default}"               # the fallback chain (and its claude-<chain> alias)

command -v claude-profiles >/dev/null 2>&1 || npm install -g @vinniai/claude-profiles

claude-profiles init

for p in $PROFILES; do
  echo "▸ creating + authenticating profile: $p"
  claude-profiles profile create "$p" --yes
  claude-profiles profile login "$p"    # opens `claude /login` against this account's config dir
done

# Build the chain in the order the profiles were listed.
claude-profiles chain create "$CHAIN" --profiles "$(echo "$PROFILES" | tr ' ' ',')"

echo
echo "✓ Done. Try it:"
echo "    claude-${CHAIN} -p 'say hi'        # runs through the chain with automatic failover"
echo "    claude-profiles chain status        # health + usage of every account"
echo "    claude-profiles chain log           # routing history (launches, switches, failovers)"
