#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ZIG_BIN="${REPO_ROOT}/.tools/zig-current/zig"

if [[ ! -x "${ZIG_BIN}" ]]; then
  echo "Local Zig toolchain is missing at ${ZIG_BIN}" >&2
  exit 1
fi

exec "${ZIG_BIN}" ar "$@"
