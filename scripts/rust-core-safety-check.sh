#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[rust-core-safety] running memphis-core tests"
cargo test -p memphis-core

echo "[rust-core-safety] running memphis-core clippy (warnings denied)"
cargo clippy -p memphis-core --all-targets -- -D warnings

if [[ "${SKIP_AUDIT:-0}" == "1" ]]; then
  echo "[rust-core-safety] skipping cargo-audit (SKIP_AUDIT=1)"
else
  echo "[rust-core-safety] running cargo-audit"
  cargo audit
fi

echo "[rust-core-safety] PASS"
