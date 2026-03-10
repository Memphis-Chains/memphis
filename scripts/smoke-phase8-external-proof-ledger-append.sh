#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-external-ledger-append-smoke"
mkdir -p "$OUT_DIR"

PROOF_OK="$OUT_DIR/proof-ok.json"
PROOF_BAD="$OUT_DIR/proof-bad.json"
LEDGER="$OUT_DIR/ledger.jsonl"

npm run -s ops:phase8-external-proof-template -- "$PROOF_OK" node-a.prod.example node-b.prod.example >/tmp/mv4-phase8-ledger-append-template.out

# positive append
npm run -s ops:phase8-external-proof-ledger-append -- "$PROOF_OK" "$LEDGER" >/tmp/mv4-phase8-ledger-append-positive.out
LINES_AFTER_OK="$(wc -l < "$LEDGER" | tr -d ' ')"
if [ "$LINES_AFTER_OK" -lt 1 ]; then
  echo "[smoke-phase8-external-proof-ledger-append] expected >=1 ledger line after valid append" >&2
  exit 1
fi

# invalid proof must fail and must not append
cat > "$PROOF_BAD" <<JSON
{
  "kind": "phase8-external-host-transport-proof",
  "ok": true,
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nodeAHost": "localhost",
  "nodeBHost": "node-b.prod.example",
  "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "nodeAHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "nodeBHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
JSON

if npm run -s ops:phase8-external-proof-ledger-append -- "$PROOF_BAD" "$LEDGER" >/tmp/mv4-phase8-ledger-append-negative.out 2>&1; then
  echo "[smoke-phase8-external-proof-ledger-append] expected invalid proof append to fail" >&2
  exit 1
fi

LINES_AFTER_BAD="$(wc -l < "$LEDGER" | tr -d ' ')"
if [ "$LINES_AFTER_BAD" -ne "$LINES_AFTER_OK" ]; then
  echo "[smoke-phase8-external-proof-ledger-append] invalid append changed ledger line count" >&2
  exit 1
fi

echo "[smoke-phase8-external-proof-ledger-append] PASS"
