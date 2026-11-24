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

# After a release build, copy the NAPI shared library to the location Node expects.
#
# Only the RELEASE profile is copied. `crates/memphis-napi/index.node` is
# the artifact that ships (see package.json "files") and the one every
# CLI invocation outside systemd resolves to, so it must always be the
# release build. A debug build overwriting it left two different Rust
# binaries reachable on one host: the service ran the release one, and
# the operator's shell ran the debug one — so `memphis vault list` and
# the runtime could disagree about what the vault held.
if [[ "${1:-}" == "build" ]]; then
  PROFILE="debug"
  for arg in "$@"; do
    if [[ "$arg" == "--release" ]]; then PROFILE="release"; fi
  done

  if [[ "${PROFILE}" != "release" ]]; then
    exit 0
  fi

  NAPI_SO="${REPO_ROOT}/target/${PROFILE}/libmemphis_napi.so"
  NAPI_DYLIB="${REPO_ROOT}/target/${PROFILE}/libmemphis_napi.dylib"
  NAPI_DEST="${REPO_ROOT}/crates/memphis-napi/index.node"
  NAPI_TMP="${NAPI_DEST}.tmp.$$"

  if [[ -f "${NAPI_SO}" ]]; then
    cp "${NAPI_SO}" "${NAPI_TMP}"
    mv -f "${NAPI_TMP}" "${NAPI_DEST}"
  elif [[ -f "${NAPI_DYLIB}" ]]; then
    cp "${NAPI_DYLIB}" "${NAPI_TMP}"
    mv -f "${NAPI_TMP}" "${NAPI_DEST}"
  fi
fi
