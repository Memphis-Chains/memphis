#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npx vitest run \
  tests/unit/cli.tui.test.ts \
  tests/tui.runtime.test.ts \
  tests/tui.command-handler.test.ts \
  tests/tui.root-layout.test.ts

echo "[smoke-tui] PASS"
