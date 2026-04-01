#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/smoke-test.sh
./scripts/smoke-tui.sh

npx vitest run \
  tests/ops/matrix-pilot-docs-contract.test.ts \
  tests/unit/cli.vault.test.ts \
  tests/unit/cli.health.test.ts \
  tests/unit/cli.init-status.test.ts \
  tests/unit/bootstrap.channel-gateway.test.ts \
  tests/unit/cross-surface-conversation-continuity.test.ts \
  tests/unit/first-run-plan.test.ts \
  tests/unit/telegram-readiness.test.ts \
  tests/unit/gateway.prompt-boundary.test.ts \
  tests/unit/in-process-tool-executor.test.ts \
  tests/unit/setup-matrix.test.ts \
  tests/unit/vault-boundary.test.ts \
  tests/unit/vault-resolve.test.ts \
  tests/unit/managed-apps.vault-boundary.test.ts \
  tests/unit/mcp-tools-extended.test.ts \
  tests/integration/vault-routes.e2e.test.ts

echo "[ga-convergence-smoke] PASS"
