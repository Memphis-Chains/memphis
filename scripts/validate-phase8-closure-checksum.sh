#!/usr/bin/env bash
set -euo pipefail

ARTIFACT="${1:-/tmp/mv4-phase8-closure/phase8-closure-artifact.json}"

node - <<'NODE' "$ARTIFACT"
const fs=require('fs');
const crypto=require('crypto');
const p=process.argv[2];
const j=JSON.parse(fs.readFileSync(p,'utf8'));
if(typeof j.schemaVersion !== 'number' || j.schemaVersion < 1) throw new Error('invalid schemaVersion');
if(!j.closureChecksum || j.closureChecksum.length!==64) throw new Error('missing closureChecksum');
const basis = JSON.stringify({
  signed: j.signed,
  sync: j.sync,
  native: j.native,
  transport: j.transport,
});
const expected = crypto.createHash('sha256').update(basis).digest('hex');
if(expected!==j.closureChecksum) throw new Error('closureChecksum mismatch');
NODE

echo "[validate-phase8-closure-checksum] PASS"
