#!/usr/bin/env bash
set -euo pipefail

NODE_A_HOST="${1:-${PHASE8_NODE_A_HOST:-}}"
NODE_B_HOST="${2:-${PHASE8_NODE_B_HOST:-}}"

is_localhost() {
  local host="$1"
  [ "$host" = "localhost" ] || [ "$host" = "127.0.0.1" ] || [ "$host" = "::1" ]
}

REASONS=()
READY=true

if [ -z "$NODE_A_HOST" ]; then
  READY=false
  REASONS+=("missing-node-a-host")
fi

if [ -z "$NODE_B_HOST" ]; then
  READY=false
  REASONS+=("missing-node-b-host")
fi

if [ -n "$NODE_A_HOST" ] && [ -n "$NODE_B_HOST" ] && [ "$NODE_A_HOST" = "$NODE_B_HOST" ]; then
  READY=false
  REASONS+=("hosts-must-differ")
fi

if [ -n "$NODE_A_HOST" ] && is_localhost "$NODE_A_HOST"; then
  READY=false
  REASONS+=("node-a-must-not-be-localhost")
fi

if [ -n "$NODE_B_HOST" ] && is_localhost "$NODE_B_HOST"; then
  READY=false
  REASONS+=("node-b-must-not-be-localhost")
fi

node - <<'NODE' "$READY" "$NODE_A_HOST" "$NODE_B_HOST" "${REASONS[*]:-}"
const ready = process.argv[2] === 'true';
const nodeAHost = process.argv[3] || null;
const nodeBHost = process.argv[4] || null;
const reasonsRaw = process.argv[5] || '';
const reasons = reasonsRaw.trim().length > 0 ? reasonsRaw.trim().split(/\s+/) : [];

console.log(JSON.stringify({
  ok: true,
  kind: 'phase8-external-proof-readiness',
  ready,
  nodeAHost,
  nodeBHost,
  reasons,
  ts: new Date().toISOString(),
}, null, 2));
NODE
