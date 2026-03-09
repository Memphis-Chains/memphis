#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/phase08-verify-tooling.sh
./scripts/phase08-smoke-pack-report.sh

echo "[phase08-preflight] PASS"
