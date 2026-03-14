#!/usr/bin/env bash
set -euo pipefail

OWNER="${GITHUB_OWNER:-Memphis-Chains}"
REPO="${GITHUB_REPO:-memphis}"
BRANCH="${GITHUB_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "[branch-protection] Missing token. Set GITHUB_TOKEN or GH_TOKEN with repo read access." >&2
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
  echo "[branch-protection] Failed to read protection (HTTP ${status_code})" >&2
  cat "$response_file" >&2
  rm -f "$response_file"
  exit 1
fi

node - "$response_file" <<'NODE'
const fs = require('node:fs');

const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const failures = [];

function expectRule(condition, message) {
  if (!condition) failures.push(message);
}

const contexts = Array.isArray(data?.required_status_checks?.contexts)
  ? data.required_status_checks.contexts
  : [];
const checks = Array.isArray(data?.required_status_checks?.checks)
  ? data.required_status_checks.checks
      .map((entry) => (typeof entry?.context === 'string' ? entry.context : null))
      .filter(Boolean)
  : [];
const allContexts = [...new Set([...contexts, ...checks])];

expectRule(data?.required_status_checks?.strict === true, 'required_status_checks.strict must be true');
expectRule(allContexts.includes('quality-gate'), 'quality-gate status check must be required');
expectRule(data?.required_pull_request_reviews?.required_approving_review_count >= 1, 'required approving reviews must be >= 1');
expectRule(data?.required_pull_request_reviews?.dismiss_stale_reviews === true, 'dismiss stale reviews must be enabled');
expectRule(data?.enforce_admins?.enabled === true, 'admin enforcement must be enabled');
expectRule(data?.required_linear_history?.enabled === true, 'linear history must be enabled');
expectRule(data?.required_conversation_resolution?.enabled === true, 'conversation resolution must be enabled');
expectRule(data?.allow_force_pushes?.enabled === false, 'force pushes must be disabled');
expectRule(data?.allow_deletions?.enabled === false, 'deletions must be disabled');

if (failures.length > 0) {
  console.error('[branch-protection] FAIL');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: {
        strictStatusChecks: data?.required_status_checks?.strict === true,
        requiredContexts: allContexts,
        adminEnforcement: data?.enforce_admins?.enabled === true,
        requiredApprovals: data?.required_pull_request_reviews?.required_approving_review_count,
        linearHistory: data?.required_linear_history?.enabled === true,
        conversationResolution: data?.required_conversation_resolution?.enabled === true,
        forcePushesAllowed: data?.allow_force_pushes?.enabled === true,
        deletionsAllowed: data?.allow_deletions?.enabled === true,
      },
    },
    null,
    2,
  ),
);
NODE

rm -f "$response_file"
