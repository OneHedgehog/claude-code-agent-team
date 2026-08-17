#!/usr/bin/env bash
# Mint a GitHub App installation access token — the reviewing identity.
#
#   ./scripts/github-app-token.sh --set-app-id 123456     store the App ID (not a secret)
#   ./scripts/github-app-token.sh --set-key < app.pem     store the private key, 0600
#   ./scripts/github-app-token.sh --check                 diagnose; prints NO token
#   ./scripts/github-app-token.sh                         print the installation token to stdout
#   ./scripts/github-app-token.sh --repo owner/name       override the target repository
#
# Consume the token so its value never lands in a transcript or shell history:
#
#   T="$(./scripts/github-app-token.sh)" \
#     curl -s -H "Authorization: Bearer $T" https://api.github.com/repos/OWNER/REPO/pulls
#
# This is the REVIEWING identity, deliberately separate from the authoring PAT that
# scripts/claude-github.sh handles. Only a GitHub App can create a check run, which is what makes
# the author/reviewer separation structural rather than a convention (FR-002, FR-022).
#
# The token is short-lived (one hour) and scoped to the installation's permissions. It is minted on
# demand and never stored, so the only durable secret is the private key.
#
# Why a file and not the keychain, unlike the PAT: `security add-generic-password -w` truncates a
# piped value at 128 characters, and a 2048-bit PEM base64s to ~2,300 — it would be stored silently
# corrupted. Passing it as an argument instead avoids the truncation but exposes the private key to
# `ps` for the duration of the call. A 0600 file is the ordinary way to hold a private key (ssh,
# TLS, GitHub Apps all do it), has no length limit, and openssl can read it directly.

set -euo pipefail

CONFIG_DIR="${GITHUB_APP_CONFIG_DIR:-$HOME/.config/github-app}"
KEY_FILE="$CONFIG_DIR/review-app.pem"
ID_FILE="$CONFIG_DIR/app-id"
API="https://api.github.com"

die() {
  echo "error: $*" >&2
  exit 1
}

# base64url: standard base64, +/ swapped for -_, padding stripped (RFC 7515).
b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }

target_repo() {
  local url
  url="$(git config --get remote.origin.url 2>/dev/null || true)"
  [ -n "$url" ] || die "no git remote 'origin'; pass --repo owner/name"

  # Accepts git@github.com:owner/name.git and https://github.com/owner/name.git alike.
  printf '%s' "$url" | sed -E 's#^.*github\.com[:/]##; s#\.git$##'
}

# A JWT signed with the App's private key, proving "I am this App". Ten minutes is the maximum
# GitHub allows; nine is used to stay clear of clock skew. This is NOT the token callers want — it
# only buys the right to exchange it for an installation token below.
mint_jwt() {
  local app_id="$1" now header payload signing_input signature
  now="$(date +%s)"

  # `iss` is the App ID as a number, matching GitHub's own examples. It is validated numeric at
  # --set-app-id, so it is safe to interpolate unquoted.
  header='{"alg":"RS256","typ":"JWT"}'
  payload="$(printf '{"iat":%d,"exp":%d,"iss":%s}' "$((now - 60))" "$((now + 540))" "$app_id")"

  signing_input="$(printf '%s' "$header" | b64url).$(printf '%s' "$payload" | b64url)"

  signature="$(
    printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$KEY_FILE" -binary | b64url
  )"

  printf '%s.%s' "$signing_input" "$signature"
}

api_get() { curl -sS -H "Authorization: Bearer $1" -H "Accept: application/vnd.github+json" "$2"; }

REPO=""
MODE="token"

while [ $# -gt 0 ]; do
  case "$1" in
  --set-app-id)
    [ $# -ge 2 ] || die "--set-app-id needs the numeric App ID"
    case "$2" in
    '' | *[!0-9]*) die "App ID must be numeric, got: $2" ;;
    esac
    mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
    printf '%s\n' "$2" >"$ID_FILE"
    echo "Stored App ID $2 in $ID_FILE"
    exit 0
    ;;
  --set-key)
    [ ! -t 0 ] || die "pipe the .pem in: $0 --set-key < your-app.private-key.pem"
    mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"

    # umask before creation, so the key is never briefly world-readable.
    (
      umask 077
      cat >"$KEY_FILE"
    )

    if ! grep -q "PRIVATE KEY" "$KEY_FILE"; then
      rm -f "$KEY_FILE"
      die "that does not look like a PEM private key; nothing was stored"
    fi

    chmod 600 "$KEY_FILE"
    echo "Stored the private key in $KEY_FILE (0600)."
    echo "Delete the downloaded .pem now — GitHub cannot show it again, but neither can an attacker."
    exit 0
    ;;
  --check) MODE="check" ;;
  --repo)
    [ $# -ge 2 ] || die "--repo needs owner/name"
    REPO="$2"
    shift
    ;;
  -h | --help)
    sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *) die "unrecognized argument: $1" ;;
  esac
  shift
done

[ -f "$ID_FILE" ] || die "no App ID stored. Run: $0 --set-app-id <id>"
[ -f "$KEY_FILE" ] || die "no private key stored. Run: $0 --set-key < your-app.private-key.pem"

# A private key readable by anyone else on the box is worth refusing over, the way ssh does.
perms="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || stat -c '%a' "$KEY_FILE")"
[ "$perms" = "600" ] || die "$KEY_FILE has permissions $perms; run: chmod 600 '$KEY_FILE'"

APP_ID="$(tr -d '[:space:]' <"$ID_FILE")"
[ -n "$APP_ID" ] || die "$ID_FILE is empty. Run: $0 --set-app-id <id>"

[ -n "$REPO" ] || REPO="$(target_repo)"

JWT="$(mint_jwt "$APP_ID")"

installation="$(api_get "$JWT" "$API/repos/$REPO/installation")"
installation_id="$(printf '%s' "$installation" | jq -r '.id // empty')"

if [ -z "$installation_id" ]; then
  message="$(printf '%s' "$installation" | jq -r '.message // "unknown error"')"
  case "$message" in
  *"Not Found"*)
    die "App $APP_ID is not installed on $REPO — install it from the App's settings page"
    ;;
  *"could not be decoded"* | *"Bad credentials"* | *"Expiration time"*)
    # "could not be decoded" is misleading: GitHub also returns it for a *well-formed* JWT when it
    # cannot find a key to verify against — an App ID that does not exist, or a private key
    # belonging to a different App. A malformed token and an unknown App are indistinguishable
    # from here, so name both rather than sending the operator to look at only one.
    die "GitHub rejected the JWT ($message). Either App $APP_ID does not exist, or the private key
       in $KEY_FILE belongs to a different App, or this machine's clock is skewed."
    ;;
  *) die "could not read the installation for $REPO: $message" ;;
  esac
fi

if [ "$MODE" = "check" ]; then
  echo "App ID:       $APP_ID"
  echo "Repository:   $REPO"
  echo "Installation: $installation_id"
  echo "Permissions:"
  printf '%s' "$installation" | jq -r '.permissions | to_entries[] | "  \(.key): \(.value)"'
  echo
  echo "No token printed. Run without --check to mint one."
  exit 0
fi

response="$(curl -sS -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "$API/app/installations/$installation_id/access_tokens")"

token="$(printf '%s' "$response" | jq -r '.token // empty')"
[ -n "$token" ] ||
  die "no token returned: $(printf '%s' "$response" | jq -r '.message // "unknown error"')"

printf '%s\n' "$token"
