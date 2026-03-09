#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm run -s test:smoke:phase5-decision
npm run -s test:smoke:phase5-transition
npm run -s test:smoke:phase6-mcp-hard
npm run -s test:smoke:phase8-sovereignty-hard

echo "[final-closure-check] PASS"
