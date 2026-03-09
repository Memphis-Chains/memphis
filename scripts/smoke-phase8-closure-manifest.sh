#!/usr/bin/env bash
set -euo pipefail

./scripts/smoke-phase8-closure-artifact.sh >/tmp/mv4-phase8-closure-manifest.out
./scripts/validate-phase8-closure-checksum.sh

OUT="/tmp/mv4-phase8-closure/phase8-closure-manifest.json"

node - <<'NODE'
const fs=require('fs');
const crypto=require('crypto');
const artifactPath='/tmp/mv4-phase8-closure/phase8-closure-artifact.json';
const artifact=JSON.parse(fs.readFileSync(artifactPath,'utf8'));
const manifest={
  schemaVersion: 1,
  artifactPath,
  closureChecksum: artifact.closureChecksum,
  generatedAt: new Date().toISOString(),
};
manifest.manifestChecksum=crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
fs.writeFileSync('/tmp/mv4-phase8-closure/phase8-closure-manifest.json', JSON.stringify(manifest, null, 2));
NODE

grep -q '"manifestChecksum": ' "$OUT"
grep -q '"closureChecksum": ' "$OUT"

echo "[smoke-phase8-closure-manifest] PASS"
