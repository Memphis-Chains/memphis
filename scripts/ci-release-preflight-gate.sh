#!/usr/bin/env bash
set -euo pipefail

TMP_ROOT="${RUNNER_TEMP:-}"
if [[ -z "$TMP_ROOT" ]]; then
  TMP_ROOT="$(mktemp -d)"
fi
mkdir -p "$TMP_ROOT"

SUMMARY_JSON="$TMP_ROOT/release-preflight-summary.json"
GATE_IDS_FILE="$TMP_ROOT/release-preflight-gate-ids.txt"
GATE_IDS_JSON_FILE="$TMP_ROOT/release-preflight-gate-ids.json"
FAILED_GATE_ID_FILE="$TMP_ROOT/release-preflight-failed-gate-id.txt"
HAS_GATES_FILE="$TMP_ROOT/release-preflight-has-gates.txt"
PARSE_ERROR_FILE="$TMP_ROOT/release-preflight-parse-error.log"
STEP_SUMMARY_PATH="${GITHUB_STEP_SUMMARY:-/dev/null}"

: >"$GATE_IDS_FILE"
: >"$GATE_IDS_JSON_FILE"
: >"$FAILED_GATE_ID_FILE"
printf '0\n' >"$HAS_GATES_FILE"
: >"$PARSE_ERROR_FILE"

set +e
npm run -s ops:release-preflight -- --json >"$SUMMARY_JSON"
PREFLIGHT_EXIT=$?
set -e

SUMMARY_JSON_MISSING=0
SUMMARY_JSON_INVALID=0

if [[ ! -s "$SUMMARY_JSON" ]]; then
  SUMMARY_JSON_MISSING=1
else
  set +e
  node -e "
    const fs = require('node:fs');
    const summary = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const gates = Array.isArray(summary?.gates) ? summary.gates : [];
    const gateIds = gates
      .map((gate) => (typeof gate?.id === 'string' ? gate.id.trim() : ''))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    const failedGate = gates.find((gate) => gate?.ok === false);
    const failedGateId =
      typeof failedGate?.id === 'string' ? failedGate.id.trim() : '';
    fs.writeFileSync(process.argv[2], gateIds.length > 0 ? gateIds.join('\n') + '\n' : '');
    fs.writeFileSync(process.argv[3], JSON.stringify(gateIds));
    fs.writeFileSync(process.argv[4], failedGateId.length > 0 ? failedGateId + '\n' : '');
    fs.writeFileSync(process.argv[5], gates.length > 0 ? '1\n' : '0\n');
  " \
    "$SUMMARY_JSON" \
    "$GATE_IDS_FILE" \
    "$GATE_IDS_JSON_FILE" \
    "$FAILED_GATE_ID_FILE" \
    "$HAS_GATES_FILE" \
    2>"$PARSE_ERROR_FILE"
  PARSE_EXIT=$?
  set -e
  if [[ "$PARSE_EXIT" -ne 0 ]]; then
    SUMMARY_JSON_INVALID=1
  fi
fi

HAS_GATES="$(tr -d '\n' <"$HAS_GATES_FILE")"
FAILED_GATE_ID="$(tr -d '\n' <"$FAILED_GATE_ID_FILE")"

echo 'Release preflight JSON summary:'
if [[ -s "$SUMMARY_JSON" ]]; then
  cat "$SUMMARY_JSON"
else
  echo '(missing summary output)'
fi

echo 'Release preflight gate IDs (sorted):'
if [[ -s "$GATE_IDS_FILE" ]]; then
  cat "$GATE_IDS_FILE"
else
  echo '(none)'
fi

{
  echo '### Release preflight JSON summary'
  echo '```json'
  if [[ -s "$SUMMARY_JSON" ]]; then
    cat "$SUMMARY_JSON"
  else
    echo '{}'
  fi
  echo '```'
  echo
  echo '### Release preflight gate IDs (sorted)'
  if [[ -s "$GATE_IDS_FILE" ]]; then
    while IFS= read -r gate_id; do
      printf -- '- `%s`\n' "$gate_id"
    done < "$GATE_IDS_FILE"
  else
    echo '- `(none)`'
  fi
} >> "$STEP_SUMMARY_PATH"

if [[ "$PREFLIGHT_EXIT" -ne 0 ]]; then
  TRIAGE_ANCHOR='ci-preflight-failure-triage-map'
  TRIAGE_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-Memphis-Chains/MemphisOS}/blob/${GITHUB_SHA:-HEAD}/docs/runbooks/RELEASE.md#ci-preflight-failure-triage-map"
  if [[ -n "$FAILED_GATE_ID" ]]; then
    TRIAGE_ANCHOR="ci-preflight-gate-${FAILED_GATE_ID}"
    TRIAGE_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-Memphis-Chains/MemphisOS}/blob/${GITHUB_SHA:-HEAD}/docs/runbooks/RELEASE.md#${TRIAGE_ANCHOR}"
  fi

  if [[ "$SUMMARY_JSON_MISSING" -eq 1 ]]; then
    echo '::error::release preflight did not emit JSON summary'
  elif [[ "$SUMMARY_JSON_INVALID" -eq 1 ]]; then
    cat "$PARSE_ERROR_FILE" >&2
    echo '::error::release preflight emitted invalid JSON summary'
  elif [[ "$HAS_GATES" != '1' ]]; then
    echo '::error::release preflight emitted empty gates list'
  fi

  echo "::error::Release preflight failed. Remediation: ${TRIAGE_URL}"
  {
    echo
    echo '### Release preflight remediation'
    echo "- [${TRIAGE_URL}](${TRIAGE_URL})"
  } >> "$STEP_SUMMARY_PATH"

  exit "$PREFLIGHT_EXIT"
fi

if [[ "$SUMMARY_JSON_MISSING" -eq 1 ]]; then
  echo '::error::release preflight did not emit JSON summary'
  exit 1
fi

if [[ "$SUMMARY_JSON_INVALID" -eq 1 ]]; then
  cat "$PARSE_ERROR_FILE" >&2
  echo '::error::release preflight emitted invalid JSON summary'
  exit 1
fi

if [[ "$HAS_GATES" != '1' ]]; then
  echo '::error::release preflight emitted empty gates list'
  exit 1
fi

if [[ "${MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT:-}" == "1" ]]; then
  if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
    echo '::error::MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT=1 requires GITHUB_OUTPUT'
    exit 1
  fi

  PREFLIGHT_GATE_IDS_JSON="$(tr -d '\n' <"$GATE_IDS_JSON_FILE")"
  if [[ -z "$PREFLIGHT_GATE_IDS_JSON" ]]; then
    PREFLIGHT_GATE_IDS_JSON='[]'
  fi
  {
    echo "preflight_summary_json<<EOF"
    cat "$SUMMARY_JSON"
    echo "EOF"
    echo "preflight_gate_ids=$PREFLIGHT_GATE_IDS_JSON"
  } >> "$GITHUB_OUTPUT"

  if [[ "${MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT:-}" == "1" ]]; then
    if ! grep -q '^check_order_status=' "$GITHUB_OUTPUT" || ! grep -q '^check_ids=' "$GITHUB_OUTPUT"; then
      echo '::error::strict-handoff gate outputs were not emitted by ops:release-preflight'
      exit 1
    fi
  fi
fi
