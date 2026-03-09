#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -f data/decision-audit.jsonl data/decision-history.jsonl

REC='{"id":"corr-1","title":"Correlation test","options":["a","b"],"confidence":0.8,"status":"proposed","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:00:00.000Z"}'
npm run -s cli -- decide transition --input "$REC" --to accepted --json >/tmp/mv4-corr.out

node - <<'NODE'
const fs=require('fs');
const audit=JSON.parse(fs.readFileSync('data/decision-audit.jsonl','utf8').trim().split('\n').at(-1));
const hist=JSON.parse(fs.readFileSync('data/decision-history.jsonl','utf8').trim().split('\n').at(-1));
if(!audit.correlationId) throw new Error('missing audit correlationId');
if(!hist.correlationId) throw new Error('missing history correlationId');
if(audit.correlationId !== hist.correlationId) throw new Error('correlation mismatch');
NODE

echo "[smoke-phase5-correlation] PASS"
