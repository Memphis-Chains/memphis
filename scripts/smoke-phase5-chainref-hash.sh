#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -f data/decision-history.jsonl data/decision-audit.jsonl
REC='{"id":"hash-1","title":"Hash test","options":["a","b"],"confidence":0.8,"status":"proposed","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:00:00.000Z"}'
OUT="$(npm run -s cli -- decide transition --input "$REC" --to accepted --json)"

# validate history file has 64-char hash in latest entry
node - <<'NODE'
const fs=require('fs');
const lines=fs.readFileSync('data/decision-history.jsonl','utf8').trim().split('\n').filter(Boolean);
const j=JSON.parse(lines[lines.length-1]);
if(!j.chainRef || typeof j.chainRef.hash!=='string' || j.chainRef.hash.length!==64) process.exit(1);
if(j.chainRef.chain!=='decision-audit') process.exit(1);
if(typeof j.chainRef.index!=='number' || j.chainRef.index < 1) process.exit(1);
NODE

echo "[smoke-phase5-chainref-hash] PASS"
