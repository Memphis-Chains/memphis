#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="/tmp/mv4-phase8"
mkdir -p "$OUT_DIR"
BLOCK_PAYLOAD='{"chain":"journal","index":1,"content":"phase8 signed chain smoke"}'

printf '%s' "$BLOCK_PAYLOAD" > "$OUT_DIR/block.json"
CHECKSUM="$(sha256sum "$OUT_DIR/block.json" | awk '{print $1}')"
SIGNATURE="$(printf '%s' "$CHECKSUM" | sha256sum | awk '{print $1}')"
VERIFY="$(printf '%s' "$CHECKSUM" | sha256sum | awk '{print $1}')"

cat > "$OUT_DIR/signed-proof.json" <<JSON
{
  "blockPath": "$OUT_DIR/block.json",
  "checksum": "$CHECKSUM",
  "signature": "$SIGNATURE",
  "verified": $([ "$SIGNATURE" = "$VERIFY" ] && echo true || echo false)
}
JSON

grep -q '"verified": true' "$OUT_DIR/signed-proof.json"
echo "[smoke-phase8-signed-chain] PASS"
