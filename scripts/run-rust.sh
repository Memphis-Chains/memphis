#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
LOCAL_WRAPPER="${REPO_ROOT}/scripts/with-local-rust.sh"
CARGO_HOME_CANDIDATE="${CARGO_HOME:-$HOME/.cargo}"

run_cargo() {
  if [[ -x "${LOCAL_WRAPPER}" ]]; then
    "${LOCAL_WRAPPER}" cargo "$@"
  elif command -v cargo >/dev/null 2>&1; then
    cargo "$@"
  elif [[ -x "${CARGO_HOME_CANDIDATE}/bin/cargo" ]]; then
    export PATH="${CARGO_HOME_CANDIDATE}/bin:${PATH}"
    cargo "$@"
  else
    echo "error: cargo not found. Install Rust via rustup or provide scripts/with-local-rust.sh." >&2
    exit 1
  fi
}

run_cargo "$@"

# After a build, copy the NAPI shared library to the location Node expects.
if [[ "${1:-}" == "build" ]]; then
  PROFILE="debug"
  for arg in "$@"; do
    if [[ "$arg" == "--release" ]]; then PROFILE="release"; fi
  done

  NAPI_SO="${REPO_ROOT}/target/${PROFILE}/libmemphis_napi.so"
  NAPI_DYLIB="${REPO_ROOT}/target/${PROFILE}/libmemphis_napi.dylib"
  NAPI_DEST="${REPO_ROOT}/crates/memphis-napi/index.node"

  if [[ -f "${NAPI_SO}" ]]; then
    cp "${NAPI_SO}" "${NAPI_DEST}"
  elif [[ -f "${NAPI_DYLIB}" ]]; then
    cp "${NAPI_DYLIB}" "${NAPI_DEST}"
  fi
fi
