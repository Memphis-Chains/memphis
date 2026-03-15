#!/usr/bin/env bash
set -euo pipefail

OUT="$(npm run -s ops:validate-strict-handoff-fixtures -- --json)"
printf '%s\n' "$OUT"

jq -e '.ok == true' <<<"$OUT" >/dev/null

EXPECTED_IDS="$(jq -c '.checkIds' tests/fixtures/strict-handoff/validator-output-contract.json)"
ACTUAL_IDS="$(jq -c '.checks | map(.id)' <<<"$OUT")"
if [[ "$ACTUAL_IDS" != "$EXPECTED_IDS" ]]; then
  echo "::error::strict-handoff validator check-id ordering mismatch"
  echo "::error::expected=$EXPECTED_IDS"
  echo "::error::actual=$ACTUAL_IDS"
  exit 1
fi

if [[ "${MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT:-}" == "1" ]]; then
  if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
    echo "::error::MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT=1 requires GITHUB_OUTPUT"
    exit 1
  fi
  echo "check_order_status=matched" >>"$GITHUB_OUTPUT"
  echo "check_ids=$ACTUAL_IDS" >>"$GITHUB_OUTPUT"
fi
