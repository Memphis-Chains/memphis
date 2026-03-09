#!/usr/bin/env bash
set -euo pipefail

LEDGER="${1:-data/phase8-closure-ledger.jsonl}"

if [ ! -f "$LEDGER" ]; then
  echo "[validate-phase8-closure-ledger] missing ledger: $LEDGER" >&2
  exit 2
fi

node - <<'NODE' "$LEDGER"
const fs=require('fs');
const p=process.argv[2];
const lines=fs.readFileSync(p,'utf8').split('\n').map(x=>x.trim()).filter(Boolean);
if(lines.length===0) throw new Error('empty ledger');
let prevTs = 0;
for(const line of lines){
  const j=JSON.parse(line);
  if(!j.closureChecksum || j.closureChecksum.length!==64) throw new Error('invalid closureChecksum');
  if(!j.manifestChecksum || j.manifestChecksum.length!==64) throw new Error('invalid manifestChecksum');
  const ts = Date.parse(j.ts);
  if(!Number.isFinite(ts)) throw new Error('invalid ts');
  if(ts < prevTs) throw new Error('non-monotonic ts');
  prevTs = ts;
}
NODE

echo "[validate-phase8-closure-ledger] PASS"
