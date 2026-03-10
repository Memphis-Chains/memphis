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
const latestClosure = [...entries].reverse().find((e)=> typeof e.closureChecksum === 'string' && e.closureChecksum.length===64) ?? null;
const latestExternalProof = [...entries].reverse().find((e)=> e.proofType === 'phase8-external-host-transport-proof') ?? null;
console.log(JSON.stringify({
  ok:true,
  entries: entries.length,
  latest: last ? {
    ts:last.ts,
    schemaVersion:last.schemaVersion,
    proofType:last.proofType ?? null,
    closureChecksum:last.closureChecksum ?? null,
    manifestChecksum:last.manifestChecksum ?? null,
    proofChecksum:last.proofChecksum ?? null,
  } : null,
  latestClosure,
  latestExternalProof,
}, null, 2));
NODE
