#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -f data/decision-history.jsonl

REC='{"id":"hist-1","title":"Pick provider","options":["ollama","openai"],"confidence":0.8,"status":"proposed","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:00:00.000Z"}'
npm run -s cli -- decide transition --input "$REC" --to accepted --json >/tmp/mv4-hist-transition.out

OUT="$(npm run -s cli -- decide history --id hist-1 --json)"
echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"count": 1'
echo "$OUT" | grep -q '"id": "hist-1"'

echo "[smoke-phase5-history-filter] PASS"
