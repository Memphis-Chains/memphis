#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm run release:smoke
npm run -s ops:release-preflight -- --json

echo "release-gates: PASS"
