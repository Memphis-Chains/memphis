#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -rf data/phase08 data/retrieval-benchmark-reports

echo "[phase08-clean] removed: data/phase08 data/retrieval-benchmark-reports"
