#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="${1:-data/phase08}"
mkdir -p "$OUT_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$OUT_DIR/smoke-pack-$TS.log"
SUMMARY="$OUT_DIR/latest-summary.txt"

./scripts/phase08-smoke-pack.sh | tee "$LOG"

echo "timestamp_utc=$TS" > "$SUMMARY"
echo "head=$(git rev-parse --short HEAD)" >> "$SUMMARY"
echo "log=$LOG" >> "$SUMMARY"
echo "status=PASS" >> "$SUMMARY"

echo "[phase08-report] summary=$SUMMARY"
