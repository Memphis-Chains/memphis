#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN_DIR="${REPO_ROOT}/.tools/node-current/bin"

if [[ ! -x "${NODE_BIN_DIR}/node" || ! -x "${NODE_BIN_DIR}/npm" ]]; then
  echo "Local Node.js toolchain is missing at ${NODE_BIN_DIR}" >&2
  exit 1
fi

export PATH="${NODE_BIN_DIR}:${PATH}"

if [[ $# -eq 0 ]]; then
  exec bash
fi

exec "$@"
