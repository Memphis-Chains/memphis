#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ZIG_BIN="${REPO_ROOT}/.tools/zig-current/zig"

if [[ ! -x "${ZIG_BIN}" ]]; then
  echo "Local Zig toolchain is missing at ${ZIG_BIN}" >&2
  exit 1
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
