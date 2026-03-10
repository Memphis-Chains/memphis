#!/usr/bin/env bash
set -euo pipefail

NODE_A_HOST="${1:-${PHASE8_NODE_A_HOST:-}}"
NODE_B_HOST="${2:-${PHASE8_NODE_B_HOST:-}}"

is_localhost() {
  local host="$1"
  [ "$host" = "localhost" ] || [ "$host" = "127.0.0.1" ] || [ "$host" = "::1" ]
}

REASONS=()
BLOCKER_CODES=()
READY=true

if [ -z "$NODE_A_HOST" ]; then
  READY=false
  REASONS+=("missing-node-a-host")
  BLOCKER_CODES+=("MISSING_NODE_A_HOST")
fi

if [ -z "$NODE_B_HOST" ]; then
  READY=false
  REASONS+=("missing-node-b-host")
  BLOCKER_CODES+=("MISSING_NODE_B_HOST")
fi

if [ -n "$NODE_A_HOST" ] && [ -n "$NODE_B_HOST" ] && [ "$NODE_A_HOST" = "$NODE_B_HOST" ]; then
  READY=false
  REASONS+=("hosts-must-differ")
  BLOCKER_CODES+=("HOSTS_MUST_DIFFER")
fi

if [ -n "$NODE_A_HOST" ] && is_localhost "$NODE_A_HOST"; then
  READY=false
  REASONS+=("node-a-must-not-be-localhost")
  BLOCKER_CODES+=("NODE_A_LOCALHOST_FORBIDDEN")
fi

if [ -n "$NODE_B_HOST" ] && is_localhost "$NODE_B_HOST"; then
  READY=false
  REASONS+=("node-b-must-not-be-localhost")
  BLOCKER_CODES+=("NODE_B_LOCALHOST_FORBIDDEN")
fi

STATUS="READY"
PRIMARY_BLOCKER_CODE="NONE"
if [ "$READY" = "false" ]; then
  STATUS="BLOCKED"
  PRIMARY_BLOCKER_CODE="${BLOCKER_CODES[0]:-UNKNOWN_BLOCKER}"
fi

node - <<'NODE' "$READY" "$STATUS" "$PRIMARY_BLOCKER_CODE" "$NODE_A_HOST" "$NODE_B_HOST" "${REASONS[*]:-}" "${BLOCKER_CODES[*]:-}"
const ready = process.argv[2] === 'true';
const status = process.argv[3] || (ready ? 'READY' : 'BLOCKED');
const blockerCode = process.argv[4] || (ready ? 'NONE' : 'UNKNOWN_BLOCKER');
const nodeAHost = process.argv[5] || null;
const nodeBHost = process.argv[6] || null;
const reasonsRaw = process.argv[7] || '';
const blockerCodesRaw = process.argv[8] || '';
const reasons = reasonsRaw.trim().length > 0 ? reasonsRaw.trim().split(/\s+/) : [];
const blockerCodes = blockerCodesRaw.trim().length > 0 ? blockerCodesRaw.trim().split(/\s+/) : [];

console.log(JSON.stringify({
  ok: true,
  kind: 'phase8-external-proof-readiness',
  status,
  blockerCode,
  blockerCodes,
  ready,
  nodeAHost,
  nodeBHost,
  reasons,
  ts: new Date().toISOString(),
}, null, 2));
NODE
