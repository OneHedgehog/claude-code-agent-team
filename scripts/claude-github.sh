#!/usr/bin/env bash
# Launch Claude Code with the GitHub PAT available to the MCP server.
#
#   ./scripts/claude-github.sh --set    store the token in the macOS keychain (prompts)
#   ./scripts/claude-github.sh          read it from the keychain and start claude
#
# The token is never typed on a command line, so it stays out of shell history.
# It IS inherited by processes claude spawns, including the agent's own shell —
# containment here is the token's own scope and expiry, not this script.

set -euo pipefail

SERVICE="github-mcp-pat"

if [ "${1:-}" = "--set" ]; then
  security add-generic-password -s "$SERVICE" -a "$USER" -U -w
  echo "Stored '$SERVICE' in the keychain."
  exit 0
fi

if ! security find-generic-password -s "$SERVICE" >/dev/null 2>&1; then
  echo "No '$SERVICE' in the keychain. Run: $0 --set" >&2
  exit 1
fi

GITHUB_MCP_PAT="$(security find-generic-password -s "$SERVICE" -w)" exec claude "$@"
