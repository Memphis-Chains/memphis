#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ZIG_BIN="${REPO_ROOT}/.tools/zig-current/zig"

# Fall back to system cc when Zig is not installed
if [[ ! -x "${ZIG_BIN}" ]]; then
  exec cc "$@"
fi

args=()
for arg in "$@"; do
  case "${arg}" in
    --target=x86_64-unknown-linux-gnu)
      args+=("--target=x86_64-linux-gnu")
      ;;
    --target=aarch64-unknown-linux-gnu)
      args+=("--target=aarch64-linux-gnu")
      ;;
    *)
      args+=("${arg}")
      ;;
  esac
done

exec "${ZIG_BIN}" cc "${args[@]}"
