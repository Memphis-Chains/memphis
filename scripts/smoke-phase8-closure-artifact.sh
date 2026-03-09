#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-closure"
mkdir -p "$OUT_DIR"

./scripts/smoke-phase8-signed-chain.sh
./scripts/validate-phase8-signed-proof.sh
./scripts/smoke-phase8-two-node-sync.sh
./scripts/validate-phase8-sync-proof.sh
./scripts/smoke-phase8-native-report.sh

node - <<'NODE'
const fs=require('fs');
const out='/tmp/mv4-phase8-closure/phase8-closure-artifact.json';
const signed=JSON.parse(fs.readFileSync('/tmp/mv4-phase8/signed-proof.json','utf8'));
const sync=JSON.parse(fs.readFileSync('/tmp/mv4-phase8-sync/sync-proof.json','utf8'));
const native=JSON.parse(fs.readFileSync('/tmp/mv4-phase8-native/phase8-native-report.json','utf8'));
const artifact={
  ok: true,
  signed: { verified: signed.verified, checksum: signed.checksum },
  sync: { synced: sync.synced, nodeAHash: sync.nodeAHash, nodeBHash: sync.nodeBHash },
  native: { ok: native.ok, marker: native.marker },
  ts: new Date().toISOString(),
};
fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
NODE

grep -q '"ok": true' "$OUT_DIR/phase8-closure-artifact.json"
echo "[smoke-phase8-closure-artifact] PASS"
