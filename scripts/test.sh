#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm run test:rust
MEMPHIS_QUIET_TEST_LOGS=1 npm run test:ts
npm run test:smoke

echo "TEST_STACK_OK"
