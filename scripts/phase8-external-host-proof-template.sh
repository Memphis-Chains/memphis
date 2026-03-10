#!/usr/bin/env bash
set -euo pipefail

OUT_PATH="${1:-/tmp/mv4-phase8-external-host-proof.json}"
NODE_A_HOST="${2:-node-a.example.net}"
NODE_B_HOST="${3:-node-b.example.net}"

if [ "$NODE_A_HOST" = "$NODE_B_HOST" ]; then
  echo "node hosts must differ" >&2
  exit 1
fi

PAYLOAD="${PAYLOAD_OVERRIDE:-phase8 external-host transport proof}"
PAYLOAD_HASH="$(printf '%s' "$PAYLOAD" | sha256sum | awk '{print $1}')"
TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$OUT_PATH" <<JSON
{
  "kind": "phase8-external-host-transport-proof",
  "ok": true,
  "timestamp": "$TS",
  "nodeAHost": "$NODE_A_HOST",
  "nodeBHost": "$NODE_B_HOST",
  "payload": "$PAYLOAD",
  "payloadHash": "$PAYLOAD_HASH",
  "nodeAHash": "$PAYLOAD_HASH",
  "nodeBHash": "$PAYLOAD_HASH",
  "notes": "Replace with real captured values from two external hosts before publication."
}
JSON

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/validate-phase8-external-host-proof.sh" "$OUT_PATH"

echo "[phase8-external-host-proof-template] wrote $OUT_PATH"
