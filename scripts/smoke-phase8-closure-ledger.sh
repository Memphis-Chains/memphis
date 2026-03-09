#!/usr/bin/env bash
set -euo pipefail

LEDGER="data/phase8-closure-ledger.jsonl"
mkdir -p data

BEFORE=0
if [ -f "$LEDGER" ]; then
  BEFORE="$(wc -l < "$LEDGER" | tr -d ' ')"
fi

./scripts/smoke-phase8-closure-manifest.sh >/tmp/mv4-phase8-closure-ledger.out

MANIFEST="/tmp/mv4-phase8-closure/phase8-closure-manifest.json"
node - <<'NODE' "$MANIFEST" "$LEDGER"
const fs=require('fs');
const manifestPath=process.argv[2];
const ledgerPath=process.argv[3];
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const entry={
  ts:new Date().toISOString(),
  closureChecksum: manifest.closureChecksum,
  manifestChecksum: manifest.manifestChecksum,
  schemaVersion: manifest.schemaVersion,
};
fs.appendFileSync(ledgerPath, JSON.stringify(entry)+'\n');
NODE

AFTER="$(wc -l < "$LEDGER" | tr -d ' ')"
if [ "$AFTER" -le "$BEFORE" ]; then
  echo "ledger append failed" >&2
  exit 1
fi

tail -n 1 "$LEDGER" | grep -q '"closureChecksum":'

echo "[smoke-phase8-closure-ledger] PASS"
