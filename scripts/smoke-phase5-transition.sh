#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

AUDIT_PATH="data/decision-audit.jsonl"
rm -f "$AUDIT_PATH"

REC='{"id":"d1","title":"Pick provider","options":["ollama","openai"],"confidence":0.8,"status":"proposed","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:00:00.000Z"}'

OUT="$(npm run -s cli -- decide transition --input "$REC" --to accepted --json)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"mode": "decide-transition"'
echo "$OUT" | grep -q '"status": "accepted"'
echo "$OUT" | grep -q '"eventId": '
echo "$OUT" | grep -q '"path": '

test -f "$AUDIT_PATH"
grep -q '"decisionId":"d1"' "$AUDIT_PATH"

echo "[smoke-phase5-transition] PASS"
