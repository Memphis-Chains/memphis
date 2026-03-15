#!/usr/bin/env bash
set -euo pipefail

OWNER="${GITHUB_OWNER:-Memphis-Chains}"
REPO="${GITHUB_REPO:-MemphisOS}"
BRANCH="${GITHUB_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
PROFILE="${MEMPHIS_BRANCH_PROTECTION_PROFILE:-team}"

case "$PROFILE" in
  solo)
    expected_required_reviews=0
    ;;
  team)
    expected_required_reviews=1
    ;;
  *)
    echo "[verify-branch-protection] Invalid MEMPHIS_BRANCH_PROTECTION_PROFILE=${PROFILE} (expected solo|team)" >&2
    exit 2
    ;;
esac

if [[ -z "$TOKEN" ]]; then
  echo "[verify-branch-protection] Missing token. Set GITHUB_TOKEN or GH_TOKEN." >&2
  exit 2
fi

response_file="$(mktemp)"
status_code="$(
  curl -sS \
    -o "$response_file" \
    -w '%{http_code}' \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${TOKEN}" \
    "https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}/protection"
)"

if [[ "$status_code" != "200" ]]; then
  echo "[verify-branch-protection] Failed (HTTP ${status_code})" >&2
  cat "$response_file" >&2
  rm -f "$response_file"
  exit 1
fi

required_contexts="$(jq -r '.required_status_checks.contexts[]?' "$response_file")"
if ! grep -qx 'quality-gate' <<<"$required_contexts"; then
  echo "[verify-branch-protection] Missing required status check: quality-gate" >&2
  cat "$response_file" >&2
  rm -f "$response_file"
  exit 1
fi

enforce_admins="$(jq -r '.enforce_admins.enabled' "$response_file")"
linear_history="$(jq -r '.required_linear_history.enabled' "$response_file")"
force_pushes="$(jq -r '.allow_force_pushes.enabled' "$response_file")"
required_reviews="$(jq -r '.required_pull_request_reviews.required_approving_review_count' "$response_file")"

if [[ "$enforce_admins" != "true" || "$linear_history" != "true" || "$force_pushes" != "false" ]]; then
  echo "[verify-branch-protection] Policy mismatch" >&2
  cat "$response_file" >&2
  rm -f "$response_file"
  exit 1
fi

if [[ "$required_reviews" != "$expected_required_reviews" ]]; then
  echo "[verify-branch-protection] Required review count mismatch: expected=${expected_required_reviews} actual=${required_reviews}" >&2
  cat "$response_file" >&2
  rm -f "$response_file"
  exit 1
fi

echo "[verify-branch-protection] OK for ${OWNER}/${REPO}:${BRANCH} (profile=${PROFILE})"
rm -f "$response_file"
