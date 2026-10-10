#!/usr/bin/env bash
set -euo pipefail

# enforce-branch-protection.sh — put main's ruleset where it belongs.
#
# WHY THIS USES RULESETS, NOT /branches/{branch}/protection
# --------------------------------------------------------
# The previous version PUT to /repos/{owner}/{repo}/branches/{branch}/protection.
# Measured 2026-10-09 against Memphis-Chains/memphis: that endpoint answers 404
# "Branch not protected", because the repository has a *ruleset* named "main",
# not classic branch protection. So `enforce` could never have applied anything,
# and nobody noticed because nothing in CI ran it.
#
# Rulesets are the current interface and they are what this repository uses.
# `~DEFAULT_BRANCH` is resolved by GitHub to whatever the default branch is,
# so the rule does not silently stop applying if the branch is renamed.
#
# WHY THESE FOUR CHECKS
# --------------------
#   quality-gate                     the real one: lint, typecheck, knip, all
#                                     three secret scans, mutation gate, preflight
#   chain-invariant                  chain shape compatibility
#   cross-arch (macos-latest)        regressions that only fire on arm/mac
#   cross-arch (ubuntu-24.04-arm)
#
# `strict_required_status_checks_policy: true` means the branch must be up to
# date with main before merging — without it, a green run from before a push is
# accepted as evidence for new code.
#
# WHAT IS DELIBERATELY NOT HERE
# -----------------------------
# The Telegram smoke check is not required. It exits 78 when its secrets are
# absent, on purpose: "skipped is not success", so a green row means a message
# was actually sent. A check that can never be green without secrets must never
# be a merge gate, or it blocks every merge forever. It runs on its own schedule
# and stays advisory.
#
# There is also no `pull_request` rule. Measured against the API: a ruleset
# carrying one rejects `required_approving_review_count: 0` with HTTP 422
# ("Invalid property /rules/N"), and `dismiss_stale_reviews_on_push` does not
# exist on the ruleset schema at all — it is a repository setting, not a ruleset
# rule. Solo operation needs no review requirement, so the rule is omitted
# rather than fought with.
#
# ON READING HTTP STATUSES HERE
# -----------------------------
# Every request writes the body to one file and the status to another, and no
# request runs inside a pipeline. Three earlier shapes were measured and lost the
# status: appending it after the body on stdout (jq parsed the trailing "200"),
# setting a variable inside a helper called from a pipeline (that body is a
# subshell and cannot export to its parent), and setting a global from inside the
# helper (same subshell boundary). A status file written by the caller is the
# only one that survives.

OWNER="${GITHUB_OWNER:-Memphis-Chains}"
REPO="${GITHUB_REPO:-memphis}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
RULESET_NAME="${MEMPHIS_MAIN_RULESET_NAME:-main}"
API="${GITHUB_API_URL:-https://api.github.com}"

if [[ -z "$TOKEN" ]]; then
  echo "[branch-protection] Missing token. Set GITHUB_TOKEN or GH_TOKEN with repo admin scope." >&2
  exit 2
fi

# The profile is accepted for compatibility with the previous version. Solo is
# what this repository runs; `team` differs only by review count, which lives in
# the `pull_request` rule this script deliberately does not write.
case "${MEMPHIS_BRANCH_PROTECTION_PROFILE:-solo}" in
  solo|team) ;;
  *)
    echo "[branch-protection] Invalid MEMPHIS_BRANCH_PROTECTION_PROFILE (expected solo|team)" >&2
    exit 2
    ;;
esac

base="/repos/${OWNER}/${REPO}/rulesets"

# request <out-file> <status-file> <method> <path> [body-file]
request() {
  local out="$1" status="$2" method="$3" path="$4" body="${5:-}"
  local code
  if [[ -n "$body" ]]; then
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${TOKEN}" \
      "${API}${path}" -d "@${body}")"
  else
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${TOKEN}" \
      "${API}${path}")"
  fi
  printf '%s' "$code" >"$status"
}

require_2xx() { # <status-file> <what>
  local code
  code="$([[ -s "$1" ]] && cat "$1" || echo unknown)"
  case "$code" in
    200|201) return 0 ;;
    *)
      echo "[branch-protection] ${2} failed (HTTP ${code})" >&2
      [[ -s "${work:-}/write.json" ]] && cat "${work}/write.json" >&2
      exit 1
      ;;
  esac
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Reuse the existing ruleset if there is one, otherwise create it. Measured: the
# repo already has a ruleset named "main", so a blind POST would create a second
# one and leave the operator guessing which is live.
request "$work/list.json" "$work/list.status" GET "$base"
require_2xx "$work/list.status" "Listing rulesets"
existing_id="$(jq -r --arg n "$RULESET_NAME" '.[] | select(.name == $n) | .id' "$work/list.json" | head -1)"

jq -n --arg name "$RULESET_NAME" '{
  name: $name,
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "quality-gate" },
          { context: "chain-invariant" },
          { context: "cross-arch (macos-latest)" },
          { context: "cross-arch (ubuntu-24.04-arm)" }
        ],
        strict_required_status_checks_policy: true
      }
    }
  ]
}' >"$work/payload.json"

if [[ -n "$existing_id" ]]; then
  request "$work/write.json" "$work/write.status" PUT "${base}/${existing_id}" "$work/payload.json"
else
  request "$work/write.json" "$work/write.status" POST "$base" "$work/payload.json"
fi
require_2xx "$work/write.status" "Writing the ruleset"

if [[ -z "$existing_id" ]]; then
  existing_id="$(jq -r '.id // empty' "$work/write.json")"
fi

# Confirm by reading back, not by trusting the write. A ruleset can be stored
# with a condition that does not resolve, and then simply does not apply.
request "$work/read.json" "$work/read.status" GET "${base}/${existing_id}"
require_2xx "$work/read.status" "Reading the ruleset back"

applied="$(jq -r '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | sort | join(",")' "$work/read.json")"
expected="chain-invariant,cross-arch (macos-latest),cross-arch (ubuntu-24.04-arm),quality-gate"

if [[ "$applied" != "$expected" ]]; then
  echo "[branch-protection] Write succeeded but the rule does not read back correctly." >&2
  echo "  expected: ${expected}" >&2
  echo "  actual:   ${applied}" >&2
  echo "  A ruleset that does not apply is worse than none — it looks like protection." >&2
  exit 1
fi

echo "[branch-protection] OK for ${OWNER}/${REPO} (ruleset ${existing_id}, required: ${applied})"