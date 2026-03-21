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

env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-
}

ensure_agent_profile() {
  local data_dir agent_name owner_name profile_dir profile_path
  data_dir="$(env_value MEMPHIS_DATA_DIR)"
  if [[ -z "${data_dir// }" ]]; then
    data_dir="${HOME}/.memphis"
  elif [[ "$data_dir" == "~" ]]; then
    data_dir="${HOME}"
  elif [[ "$data_dir" == ~/* ]]; then
    data_dir="${HOME}/${data_dir#~/}"
  fi

  agent_name="$(env_value MEMPHIS_AGENT_NAME)"
  owner_name="$(env_value MEMPHIS_OWNER_NAME)"
  profile_dir="${data_dir}/config"
  profile_path="${profile_dir}/agent-profile.json"
  mkdir -p "$profile_dir"

  node -e "
    const fs = require('node:fs');
    const path = process.argv[1];
    const agentName = process.argv[2] || 'Memphis Agent';
    const ownerName = process.argv[3] || 'local operator';
    const profile = {
      schemaVersion: 1,
      agentName,
      ownerName,
      runtimeMode: 'solo-local',
      toolPolicy: 'operator-supervised',
      behaviorRules: [
        'Operate locally and keep durable memory auditable.',
        'Use tools deliberately and prefer reversible actions.',
        'Treat vault-managed secrets as operator-controlled state.',
      ],
    };
    fs.writeFileSync(path, JSON.stringify(profile, null, 2) + '\\n', 'utf8');
  " "$profile_path" "$agent_name" "$owner_name"

  log "Ensured agent profile: $profile_path"
}

main() {
  require_cmd node
  require_cmd npm

  cd "$ROOT_DIR"
  ensure_env_file

  ensure_env_value "MEMPHIS_API_TOKEN" "$(generate_token)"
  ensure_env_value "MEMPHIS_VAULT_PEPPER" "$(generate_pepper)"
  ensure_env_value "MEMPHIS_AGENT_NAME" "${MEMPHIS_AGENT_NAME:-Memphis Agent}"
  ensure_env_value "MEMPHIS_OWNER_NAME" "${MEMPHIS_OWNER_NAME:-local operator}"
  ensure_env_value "RUST_EMBED_PERSIST_ENABLED" "true"
  ensure_env_value "RUST_EMBED_PERSIST_PATH" "./data/embed-index.json"
  ensure_agent_profile

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
