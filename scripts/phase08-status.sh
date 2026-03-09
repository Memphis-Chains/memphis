#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[phase08-status] head=$(git rev-parse --short HEAD)"
echo "[phase08-status] branch=$(git rev-parse --abbrev-ref HEAD)"

if [ -f data/phase08/latest-summary.txt ]; then
  echo "[phase08-status] latest-summary=data/phase08/latest-summary.txt"
  cat data/phase08/latest-summary.txt
else
  echo "[phase08-status] latest-summary=missing"
fi

if [ -d data/retrieval-benchmark-reports ]; then
  echo "[phase08-status] retrieval-reports=present"
  ls -1 data/retrieval-benchmark-reports | head -n 5
else
  echo "[phase08-status] retrieval-reports=missing"
fi
