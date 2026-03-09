#!/usr/bin/env bash
set -euo pipefail

LEDGER="data/phase8-closure-ledger.jsonl"
if [ ! -f "$LEDGER" ]; then
  echo '{"ok":false,"reason":"missing-ledger"}'
  exit 0
fi

node - <<'NODE' "$LEDGER"
const fs=require('fs');
const p=process.argv[2];
const lines=fs.readFileSync(p,'utf8').split('\n').map(x=>x.trim()).filter(Boolean);
const entries=lines.map((l)=>JSON.parse(l));
const last=entries[entries.length-1] ?? null;
console.log(JSON.stringify({
  ok:true,
  entries: entries.length,
  latest: last ? {
    ts:last.ts,
    closureChecksum:last.closureChecksum,
    manifestChecksum:last.manifestChecksum,
    schemaVersion:last.schemaVersion,
  } : null,
}, null, 2));
NODE
