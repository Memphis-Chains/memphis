#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -f data/decision-history.jsonl

REC1='{"id":"hist-latest","title":"Pick provider","options":["ollama","openai"],"confidence":0.8,"status":"proposed","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:00:00.000Z"}'
REC2='{"id":"hist-latest","title":"Pick provider","options":["ollama","openai"],"confidence":0.8,"status":"accepted","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:01:00.000Z"}'

npm run -s cli -- decide transition --input "$REC1" --to accepted --json >/tmp/mv4-hist-latest-1.out
npm run -s cli -- decide transition --input "$REC2" --to implemented --json >/tmp/mv4-hist-latest-2.out

OUT="$(npm run -s cli -- decide history --id hist-latest --latest 1 --json)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"count": 1'
echo "$OUT" | grep -q '"latest": 1'
echo "$OUT" | grep -q '"status": "implemented"'

echo "[smoke-phase5-history-latest] PASS"
