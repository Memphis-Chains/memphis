#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ZIG_BIN="${REPO_ROOT}/.tools/zig-current/zig"
ZIG_CC_WRAPPER="${REPO_ROOT}/scripts/local-zig-cc.sh"
ZIG_CXX_WRAPPER="${REPO_ROOT}/scripts/local-zig-cxx.sh"
ZIG_AR_WRAPPER="${REPO_ROOT}/scripts/local-zig-ar.sh"

# Prefer system cargo; fall back to well-known local paths
if ! command -v cargo >/dev/null 2>&1; then
  # Try common local Rust install locations
  for candidate in "$HOME/.cargo/bin" "/home/${USER}/snap/codex/34/.cargo/bin"; do
    if [[ -x "${candidate}/cargo" && -x "${candidate}/rustc" ]]; then
      export PATH="${candidate}:${PATH}"
      break
    fi
  done
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo not found on PATH or in known local locations" >&2
    exit 1
  fi
fi

# Only configure Zig as CC/linker when the Zig binary is actually present
if [[ -x "${ZIG_BIN}" && -x "${ZIG_CC_WRAPPER}" && -x "${ZIG_CXX_WRAPPER}" ]]; then
  export CC="${ZIG_CC_WRAPPER}"
  export CXX="${ZIG_CXX_WRAPPER}"
  if [[ -x "${ZIG_AR_WRAPPER}" ]]; then
    export AR="${ZIG_AR_WRAPPER}"
  fi
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="${ZIG_CC_WRAPPER}"
fi

if [[ $# -eq 0 ]]; then
  exec bash
fi

exec "$@"
