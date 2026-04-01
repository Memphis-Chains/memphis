#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
LOCAL_WRAPPER="${REPO_ROOT}/scripts/with-local-rust.sh"
CARGO_HOME_CANDIDATE="${CARGO_HOME:-$HOME/.cargo}"

if [[ -x "${LOCAL_WRAPPER}" ]]; then
  exec "${LOCAL_WRAPPER}" cargo "$@"
fi

if command -v cargo >/dev/null 2>&1; then
  exec cargo "$@"
fi

if [[ -x "${CARGO_HOME_CANDIDATE}/bin/cargo" ]]; then
  export PATH="${CARGO_HOME_CANDIDATE}/bin:${PATH}"
  exec cargo "$@"
fi

echo "error: cargo not found. Install Rust via rustup or provide scripts/with-local-rust.sh." >&2
exit 1
