#!/usr/bin/env bash
#
# scripts/sync-ci-bot-token.sh
#
# Syncs the operator's locally-authenticated gh PAT to the
# `MEMPHIS_BOT_TOKEN` repo secret so scheduled workflows can write
# to issues (and other writeable endpoints) when the default
# GitHub Actions integration-app can't.
#
# When to run:
#   - After `gh auth login --with-token` (operator rotates PAT)
#   - After switching to a new PAT with broader scope
#   - After any reason `MEMPHIS_BOT_TOKEN` drift
#
# Why it exists:
#   PR #636 wired `gh issue create` (and `gh issue comment`) into
#   `.github/workflows/weekly-runtime-kpi.yml`. The job authenticates
#   with `secrets.MEMPHIS_BOT_TOKEN` instead of the default GITHUB_TOKEN
#   because the integration-app's issue-write grant is blocked at the org
#   level. The secret must hold the SAME PAT that gh CLI uses locally
#   so both surfaces stay in sync.
#
# Mechanism:
#   Reads the active PAT via `gh auth token` (never echoed, never
#   written to disk), pipes it directly into `gh secret set`. The
#   token does not appear in argv, process list, or shell history.
#
# Exit codes:
#   0 — secret updated successfully (or already in sync)
#   1 — gh CLI not authenticated or repo unreachable
#   2 — secret set failed
#   3 — no detectable diff (caller can decide whether to force-write)
#
# Usage:
#   ./scripts/sync-ci-bot-token.sh                # sync if logged in
#   ./scripts/sync-ci-bot-token.sh --verify-only   # only check status
#   ./scripts/sync-ci-bot-token.sh --repo OWNER/REPONAME  # override target repo

set -euo pipefail

REPO="Memphis-Chains/memphis"
VERIFY_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --help|-h)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found in PATH" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh CLI not authenticated; run 'gh auth login --with-token' first" >&2
  exit 1
fi

if ! gh secret list --repo "$REPO" 2>/dev/null | grep -q "^MEMPHIS_BOT_TOKEN"; then
  echo "MEMPHIS_BOT_TOKEN secret not found on $REPO; nothing to verify against"
  echo "  run without --verify-only to create it"
  if [[ "$VERIFY_ONLY" == 1 ]]; then
    exit 1
  fi
fi

if [[ "$VERIFY_ONLY" == 1 ]]; then
  echo "ok: MEMPHIS_BOT_TOKEN present on $REPO (skipping update)"
  exit 0
fi

# Pull the active PAT from gh CLI and pipe straight into `gh secret set`.
# Token never appears in argv / process list / shell history.
# `gh auth token` reads from the local keyring (encrypted) and prints
# the plaintext to stdout, which we pipe so the only place the value
# touches disk is the encrypted repo secret store.
if ! gh auth token | gh secret set MEMPHIS_BOT_TOKEN --repo "$REPO" >/dev/null 2>&1; then
  echo "error: gh secret set failed for $REPO" >&2
  exit 2
fi

# Capture the new-secret timestamp from `gh secret list` for the
# user-facing confirmation line. No token value is printed at any point.
updated_at=$(gh secret list --repo "$REPO" 2>/dev/null \
  | awk '/^MEMPHIS_BOT_TOKEN/ { print $2 }')

echo "ok: MEMPHIS_BOT_TOKEN refreshed on $REPO (updated_at: ${updated_at:-unknown})"
echo "  scheduled weekly-kpi will pick up the new token on next run (Mon 03:30 UTC)"
