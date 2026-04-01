#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
REAL_HOME="${HOME:-$TMP_DIR/home}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$TMP_DIR/xdg-cache" \
  "$TMP_DIR/xdg-config" \
  "$TMP_DIR/xdg-data" \
  "$TMP_DIR/npm-cache"
touch "$TMP_DIR/npmrc"

env_args=(
  -i
  "HOME=$REAL_HOME"
  "PATH=${PATH:-/usr/local/bin:/usr/bin:/bin}"
  "SHELL=${SHELL:-/bin/bash}"
  "TERM=${TERM:-dumb}"
  "LANG=${LANG:-C.UTF-8}"
  "LC_ALL=${LC_ALL:-${LANG:-C.UTF-8}}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "CARGO_HOME=${CARGO_HOME:-$REAL_HOME/.cargo}"
  "RUSTUP_HOME=${RUSTUP_HOME:-$REAL_HOME/.rustup}"
  "XDG_CACHE_HOME=$TMP_DIR/xdg-cache"
  "XDG_CONFIG_HOME=$TMP_DIR/xdg-config"
  "XDG_DATA_HOME=$TMP_DIR/xdg-data"
  "NPM_CONFIG_CACHE=$TMP_DIR/npm-cache"
  "NPM_CONFIG_USERCONFIG=$TMP_DIR/npmrc"
  "MEMPHIS_RC_DRILL_MATRIX=${MEMPHIS_RC_DRILL_MATRIX:-0}"
)

if [[ -n "${MEMPHIS_RC_DRILL_PORT:-}" ]]; then
  env_args+=("MEMPHIS_RC_DRILL_PORT=${MEMPHIS_RC_DRILL_PORT}")
fi

for proxy_var in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR; do
  if [[ -n "${!proxy_var:-}" ]]; then
    env_args+=("${proxy_var}=${!proxy_var}")
  fi
done

exec env "${env_args[@]}" bash "$ROOT_DIR/scripts/rc-drill.sh"
