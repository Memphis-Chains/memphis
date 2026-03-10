#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-external-proof-smoke"
mkdir -p "$OUT_DIR"

POSITIVE="$OUT_DIR/proof-positive.json"
NEG_LOCALHOST="$OUT_DIR/proof-negative-localhost.json"
NEG_HASH_MISMATCH="$OUT_DIR/proof-negative-hash-mismatch.json"
NEG_MISSING_FIELDS="$OUT_DIR/proof-negative-missing-fields.json"

# positive path
./scripts/phase8-external-host-proof-template.sh "$POSITIVE" node-a.prod.example node-b.prod.example >/tmp/mv4-phase8-external-proof-positive.out
./scripts/validate-phase8-external-host-proof.sh "$POSITIVE" >/tmp/mv4-phase8-external-proof-validate-positive.out

# negative 1: localhost must fail
cat > "$NEG_LOCALHOST" <<JSON
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

if ./scripts/validate-phase8-external-host-proof.sh "$NEG_LOCALHOST" >/tmp/mv4-phase8-external-proof-validate-neg-localhost.out 2>&1; then
  echo "[smoke-phase8-external-host-proof] expected validator failure for localhost proof" >&2
  exit 1
fi

# negative 2: hash mismatch must fail
cat > "$NEG_HASH_MISMATCH" <<JSON
{
  "kind": "phase8-external-host-transport-proof",
  "ok": true,
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nodeAHost": "node-a.prod.example",
  "nodeBHost": "node-b.prod.example",
  "payload": "phase8 external-host transport proof",
  "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "nodeAHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "nodeBHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
JSON

if ./scripts/validate-phase8-external-host-proof.sh "$NEG_HASH_MISMATCH" >/tmp/mv4-phase8-external-proof-validate-neg-hash.out 2>&1; then
  echo "[smoke-phase8-external-host-proof] expected validator failure for hash mismatch" >&2
  exit 1
fi

# negative 3: missing required fields must fail
cat > "$NEG_MISSING_FIELDS" <<JSON
{
  "kind": "phase8-external-host-transport-proof",
  "ok": true,
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nodeAHost": "node-a.prod.example"
}
JSON

if ./scripts/validate-phase8-external-host-proof.sh "$NEG_MISSING_FIELDS" >/tmp/mv4-phase8-external-proof-validate-neg-missing.out 2>&1; then
  echo "[smoke-phase8-external-host-proof] expected validator failure for missing fields" >&2
  exit 1
fi

echo "[smoke-phase8-external-host-proof] PASS"
