#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MEMPHIS_ENV_FILE:-$ROOT_DIR/.env}"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

log() { echo "[memphis-bootstrap] $*"; }
fail() { echo "[memphis-bootstrap][error] $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    log "Using existing env file: $ENV_FILE"
    return
  fi

  [[ -f "$ENV_EXAMPLE" ]] || fail "missing template: $ENV_EXAMPLE"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log "Created env file from template: $ENV_FILE"
}

ensure_env_value() {
  local key="$1"
  local value="$2"

  if grep -Eq "^${key}=" "$ENV_FILE"; then
    local current
    current="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
    if [[ -n "${current// }" ]]; then
      return
    fi
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    return
  fi

  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

generate_token() {
  node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
}

generate_pepper() {
  node -e "console.log('memphis-' + require('node:crypto').randomBytes(16).toString('hex'))"
}

main() {
  require_cmd node
  require_cmd npm

  cd "$ROOT_DIR"
  ensure_env_file

  ensure_env_value "MEMPHIS_API_TOKEN" "$(generate_token)"
  ensure_env_value "MEMPHIS_VAULT_PEPPER" "$(generate_pepper)"
  ensure_env_value "MEMPHIS_AGENT_NAME" "${MEMPHIS_AGENT_NAME:-Soul}"
  ensure_env_value "MEMPHIS_OWNER_NAME" "${MEMPHIS_OWNER_NAME:-Marcin}"
  ensure_env_value "RUST_EMBED_PERSIST_ENABLED" "true"
  ensure_env_value "RUST_EMBED_PERSIST_PATH" "./data/embed-index.json"

  mkdir -p "$ROOT_DIR/data" "$HOME/.memphis/embed"

  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    log "Installing npm dependencies"
    npm ci
  fi

  log "Building Memphis"
  npm run build

  log "Initializing workspace context in repo root"
  npm run -s cli -- workspace init . --json >/dev/null

  log "Bootstrap complete"
  echo
  echo "Next:"
  echo "  1. Initialize vault once:"
  echo "     npm run -s cli -- vault init --passphrase '<pass>' --recovery-question '<question>' --recovery-answer '<answer>'"
  echo "  2. Start runtime:"
  echo "     npm run dev"
  echo "  3. In another terminal:"
  echo "     npm run -s cli -- tui"
}

main "$@"
