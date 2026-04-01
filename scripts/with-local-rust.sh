#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
RUST_BASE="/home/memphis/snap/codex/34"
CARGO_BIN_DIR="${RUST_BASE}/.cargo/bin"
RUSTUP_HOME_DIR="${RUST_BASE}/.rustup"
ZIG_CC_WRAPPER="${REPO_ROOT}/scripts/local-zig-cc.sh"
ZIG_CXX_WRAPPER="${REPO_ROOT}/scripts/local-zig-cxx.sh"
ZIG_AR_WRAPPER="${REPO_ROOT}/scripts/local-zig-ar.sh"

if [[ -x "${CARGO_BIN_DIR}/cargo" && -x "${CARGO_BIN_DIR}/rustc" ]]; then
  export CARGO_HOME="${RUST_BASE}/.cargo"
  export RUSTUP_HOME="${RUSTUP_HOME_DIR}"
  export PATH="${CARGO_BIN_DIR}:${PATH}"

  if [[ -x "${ZIG_CC_WRAPPER}" && -x "${ZIG_CXX_WRAPPER}" ]]; then
    export CC="${ZIG_CC_WRAPPER}"
    export CXX="${ZIG_CXX_WRAPPER}"
    if [[ -x "${ZIG_AR_WRAPPER}" ]]; then
      export AR="${ZIG_AR_WRAPPER}"
    fi
    export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="${ZIG_CC_WRAPPER}"
  fi
elif ! command -v cargo >/dev/null 2>&1; then
  echo "Local Rust toolchain is missing at ${CARGO_BIN_DIR} and cargo is not on PATH" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  exec bash
fi

exec "$@"
