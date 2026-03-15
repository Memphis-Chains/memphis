#!/usr/bin/env bash
set -euo pipefail

OWNER="${GITHUB_OWNER:-Memphis-Chains}"
REPO="${GITHUB_REPO:-MemphisOS}"
BRANCH="${GITHUB_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
PROFILE="${MEMPHIS_BRANCH_PROTECTION_PROFILE:-team}"

if [[ -z "$TOKEN" ]]; then
  echo "[branch-protection] Missing token. Set GITHUB_TOKEN or GH_TOKEN with repo admin scope." >&2
  exit 2
fi

case "$PROFILE" in
  solo)
    required_reviews=0
    require_code_owners=false
    ;;
  team)
    required_reviews=1
    require_code_owners=false
    ;;
  *)
    echo "[branch-protection] Invalid MEMPHIS_BRANCH_PROTECTION_PROFILE=${PROFILE} (expected solo|team)" >&2
    exit 2
    ;;
esac

payload="$(
  jq -n \
    --argjson required_reviews "$required_reviews" \
    --argjson require_code_owners "$require_code_owners" \
    '{
      required_status_checks: {
        strict: true,
        contexts: ["quality-gate"]
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: $required_reviews,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: $require_code_owners,
        require_last_push_approval: false
      },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
      required_linear_history: true,
      block_creations: false,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: false
    }'
)"

response_file="$(mktemp)"
status_code="$(
  curl -sS \
    -o "$response_file" \
    -w '%{http_code}' \
    -X PUT \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    "https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}/protection" \
    -d "$payload"
)"

if [[ "$status_code" != "200" ]]; then
  echo "[branch-protection] Failed (HTTP ${status_code})" >&2
  cat "$response_file" >&2
  rm -f "$response_file"
  exit 1
fi

echo "[branch-protection] Enabled for ${OWNER}/${REPO}:${BRANCH} (profile=${PROFILE})"
cat "$response_file"
rm -f "$response_file"
