#!/usr/bin/env bash
set -euo pipefail

LEDGER="${1:-data/phase8-closure-ledger.jsonl}"
OUT="${2:-/tmp/mv4-phase8-closure/ledger-checksum.json}"

if [ ! -f "$LEDGER" ]; then
  echo "[validate-phase8-closure-ledger-checksum] missing ledger: $LEDGER" >&2
  exit 2
fi

node - <<'NODE' "$LEDGER" "$OUT"
const fs=require('fs');
const crypto=require('crypto');
const ledgerPath=process.argv[2];
const outPath=process.argv[3];
const lines=fs.readFileSync(ledgerPath,'utf8').split('\n').map(x=>x.trim()).filter(Boolean);
if(lines.length===0) throw new Error('empty ledger');
let prevTs=0;
for(const line of lines){
  const j=JSON.parse(line);
  const ts=Date.parse(j.ts);
  if(!Number.isFinite(ts) || ts<prevTs) throw new Error('non-monotonic ledger');
  prevTs=ts;
}
const checksum=crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ ok:true, entries: lines.length, checksum }, null, 2));
NODE

grep -q '"ok": true' "$OUT"
grep -q '"checksum": ' "$OUT"

echo "[validate-phase8-closure-ledger-checksum] PASS"
