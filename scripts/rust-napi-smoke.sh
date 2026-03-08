#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASS() { echo "[PASS] $1"; }
FAIL() { echo "[FAIL] $1"; exit 1; }
STEP() { echo "[STEP] $1"; }

STEP "Rust workspace tests"
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

if command -v cargo >/dev/null 2>&1; then
  cargo test --workspace >/tmp/memphis-rust-smoke.out 2>&1 || {
    cat /tmp/memphis-rust-smoke.out
    FAIL "cargo test --workspace"
  }
  PASS "cargo test --workspace"
else
  FAIL "cargo not found (install rustup + cargo first)"
fi

STEP "TypeScript quality gate"
npm run lint >/tmp/memphis-ts-lint.out 2>&1 || { cat /tmp/memphis-ts-lint.out; FAIL "npm run lint"; }
PASS "npm run lint"

npm run typecheck >/tmp/memphis-ts-typecheck.out 2>&1 || {
  cat /tmp/memphis-ts-typecheck.out
  FAIL "npm run typecheck"
}
PASS "npm run typecheck"

npm test >/tmp/memphis-ts-test.out 2>&1 || { cat /tmp/memphis-ts-test.out; FAIL "npm test"; }
PASS "npm test"

npm run build >/tmp/memphis-ts-build.out 2>&1 || { cat /tmp/memphis-ts-build.out; FAIL "npm run build"; }
PASS "npm run build"

echo "SMOKE_RUST_NAPI_OK"
