#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[h4.4] gateway /exec hardening smoke"

npx vitest run tests/unit/gateway.exec-policy.test.ts tests/integration/gateway.e2e.test.ts

echo "[h4.4] PASS"
