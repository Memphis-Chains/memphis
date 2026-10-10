#!/usr/bin/env bash
set -euo pipefail

# verify-branch-protection.sh — prove main is actually protected.
#
# WHAT THIS USED TO DO WRONG, MEASURED 2026-10-09
# ---------------------------------------------
# It read GET /repos/{owner}/{repo}/branches/{branch}/protection, which answers
# 404 "Branch not protected" for this repository — the protection lives in a
# ruleset named "main", not in classic branch protection.
#
# And then it printed:
#
#     [verify-branch-protection] Failed (HTTP 404)
#     {"message": "Branch not protected", ...}
#
# ...and exited 0. Every real failure in the function calls `exit 1`; the 404
# path did not. A verification that reports a failure and returns success is
# the shape that lets a missing gate look like a passing one, and this one had
# been reporting "no protection here" while printing a green result.
#
# So this version reads the ruleset, which is where the protection actually is,
# and treats "cannot read the ruleset" as a failure rather than as absence of
# failure.
#
# WHAT IT ASSERTS
#   - the ruleset exists, is active, and targets the default branch
#   - deletion and non-fast-forward are blocked
#   - required_status_checks contains all four contexts, strict
#   - the Telegram smoke check is NOT required (it exits 78 without secrets)
#
# That last one is the part worth keeping: a check that can never pass without
# secrets must never become a merge gate.

OWNER="${GITHUB_OWNER:-Memphis-Chains}"
REPO="${GITHUB_REPO:-memphis}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
RULESET_NAME="${MEMPHIS_MAIN_RULESET_NAME:-main}"
API="${GITHUB_API_URL:-https://api.github.com}"

EXPECTED_CONTEXTS="chain-invariant,cross-arch (macos-latest),cross-arch (ubuntu-24.04-arm),quality-gate"

if [[ -z "$TOKEN" ]]; then
  echo "[verify-branch-protection] Missing token. Set GITHUB_TOKEN or GH_TOKEN." >&2
  exit 2
fi

fail() {
  echo "[verify-branch-protection] $1" >&2
  exit 1
}

out="$(mktemp)"
code="$(curl -sS -o "$out" -w '%{http_code}' \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${API}/repos/${OWNER}/${REPO}/rulesets")"

# A read failure is a failure. The old version treated 404 as informational and
# then exited 0, which is how an unprotected main reported success.
[[ "$code" == "200" ]] || {
  echo "[verify-branch-protection] Cannot list rulesets (HTTP ${code})" >&2
  cat "$out" >&2
  rm -f "$out"
  exit 1
}

id="$(jq -r --arg n "$RULESET_NAME" '.[] | select(.name == $n) | .id' "$out" | head -1)"
rm -f "$out"

[[ -n "$id" && "$id" != "null" ]] || fail "No ruleset named '${RULESET_NAME}' — main is not protected."

out="$(mktemp)"
code="$(curl -sS -o "$out" -w '%{http_code}' \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${API}/repos/${OWNER}/${REPO}/rulesets/${id}")"

[[ "$code" == "200" ]] || {
  echo "[verify-branch-protection] Cannot read ruleset ${id} (HTTP ${code})" >&2
  cat "$out" >&2
  rm -f "$out"
  exit 1
}

enforcement="$(jq -r '.enforcement' "$out")"
[[ "$enforcement" == "active" ]] || fail "Ruleset '${RULESET_NAME}' is ${enforcement}, not active."

# Empty include + exclude would mean "applies to nothing", which reads as a
# configured rule and behaves as no rule at all.
cond_include="$(jq -r '.conditions.ref_name.include | join(",")' "$out")"
cond_exclude="$(jq -r '.conditions.ref_name.exclude | join(",")' "$out")"
[[ -n "$cond_include" ]] || fail "Ruleset '${RULESET_NAME}' has no branch condition — it does not apply anywhere."
[[ "$cond_exclude" == "" ]] || fail "Ruleset '${RULESET_NAME}' excludes: ${cond_exclude}"

rule_types="$(jq -r '[.rules[].type] | sort | join(",")' "$out")"
[[ "$rule_types" == *"deletion"* ]] || fail "Ruleset does not block deletion."
[[ "$rule_types" == *"non_fast_forward"* ]] || fail "Ruleset allows force-push."

actual="$(jq -r '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | sort | join(",")' "$out")"
[[ "$actual" == "$EXPECTED_CONTEXTS" ]] || fail "Required checks mismatch.\n  expected: ${EXPECTED_CONTEXTS}\n  actual:   ${actual}"

strict="$(jq -r '[.rules[] | select(.type == "required_status_checks") | .parameters.strict_required_status_checks_policy] | .[0]' "$out")"
[[ "$strict" == "true" ]] || fail "Required checks are not strict — a stale green run would be accepted as evidence."

# The Telegram smoke check exits 78 when its secrets are absent, by design, so
# requiring it would block every merge forever.
if grep -qx 'smoke' <<<"$(tr ',' '\n' <<<"$actual")"; then
  fail "The Telegram smoke check is required. It cannot pass without secrets."
fi

echo "[verify-branch-protection] OK for ${OWNER}/${REPO} (ruleset ${id}, ${RULESET_NAME}): required=${actual}, strict=true"
rm -f "$out"