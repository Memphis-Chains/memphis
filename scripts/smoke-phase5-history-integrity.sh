#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HIST="data/decision-history.jsonl"
rm -f "$HIST"

REC='{"id":"int-1","title":"Integrity test","options":["a","b"],"confidence":0.8,"status":"proposed","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:00:00.000Z"}'
npm run -s cli -- decide transition --input "$REC" --to accepted --json >/tmp/mv4-hist-integrity.out

node - <<'NODE' "$HIST"
const fs=require('fs');
const p=process.argv[2];
const lines=fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean);
if(lines.length!==1) throw new Error('expected one history entry');
const j=JSON.parse(lines[0]);
if(!j.decision || j.decision.id!=='int-1') throw new Error('decision id mismatch');
if(!j.chainRef || typeof j.chainRef.hash!=='string') throw new Error('missing chainRef hash');
NODE

echo "[smoke-phase5-history-integrity] PASS"
