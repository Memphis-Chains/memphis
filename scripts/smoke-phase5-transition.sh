#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REC='{"id":"d1","title":"Pick provider","options":["ollama","openai"],"confidence":0.8,"status":"proposed","schemaVersion":1,"createdAt":"2026-03-09T00:00:00.000Z","updatedAt":"2026-03-09T00:00:00.000Z"}'

OUT="$(npm run -s cli -- decide transition --input "$REC" --to accepted --json)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"mode": "decide-transition"'
echo "$OUT" | grep -q '"status": "accepted"'

echo "[smoke-phase5-transition] PASS"
