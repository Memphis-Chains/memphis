#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ZIG_BIN="${REPO_ROOT}/.tools/zig-current/zig"

# Fall back to system ar when Zig is not installed
if [[ ! -x "${ZIG_BIN}" ]]; then
  exec ar "$@"
fi

exec "${ZIG_BIN}" ar "$@"
