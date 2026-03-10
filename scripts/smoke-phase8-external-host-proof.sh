#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-external-proof-smoke"
mkdir -p "$OUT_DIR"

POSITIVE="$OUT_DIR/proof-positive.json"
NEGATIVE="$OUT_DIR/proof-negative.json"

# positive path
./scripts/phase8-external-host-proof-template.sh "$POSITIVE" node-a.prod.example node-b.prod.example >/tmp/mv4-phase8-external-proof-positive.out
./scripts/validate-phase8-external-host-proof.sh "$POSITIVE" >/tmp/mv4-phase8-external-proof-validate-positive.out

# negative path (localhost must fail)
cat > "$NEGATIVE" <<JSON
{
  "kind": "phase8-external-host-transport-proof",
  "ok": true,
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nodeAHost": "localhost",
  "nodeBHost": "node-b.prod.example",
  "payload": "phase8 external-host transport proof",
  "payloadHash": "1111111111111111111111111111111111111111111111111111111111111111",
  "nodeAHash": "1111111111111111111111111111111111111111111111111111111111111111",
  "nodeBHash": "1111111111111111111111111111111111111111111111111111111111111111"
}
JSON

if ./scripts/validate-phase8-external-host-proof.sh "$NEGATIVE" >/tmp/mv4-phase8-external-proof-validate-negative.out 2>&1; then
  echo "[smoke-phase8-external-host-proof] expected validator failure for localhost proof" >&2
  exit 1
fi

echo "[smoke-phase8-external-host-proof] PASS"
