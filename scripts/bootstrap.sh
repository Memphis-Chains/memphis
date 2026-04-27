#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MEMPHIS_ENV_FILE:-$ROOT_DIR/.env}"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENSURED_AGENT_PROFILE_PATH=""
SYSTEMD_SERVICE_STATUS="not attempted"
SYSTEMD_SERVICE_PATH=""

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
      echo "existing"
      return
    fi
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "generated"
    return
  fi

  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  echo "generated"
}

generate_token() {
  node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
}

generate_pepper() {
  node -e "console.log('memphis-' + require('node:crypto').randomBytes(16).toString('hex'))"
}

env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

systemd_user_available() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

json_field() {
  local field="$1"
  node -e "
    const fs = require('node:fs');
    const raw = fs.readFileSync(0, 'utf8');
    // \`memphis service <cmd> --json\` may prefix logs/warnings before the
    // JSON line (e.g. pino logs, deprecation warnings). Scan backwards for
    // the last line that parses as a JSON object; fall back to whole-input
    // parse for the happy single-JSON case; emit nothing on total failure.
    const lines = raw.split('\n');
    let payload = null;
    for (let i = lines.length - 1; i >= 0 && !payload; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      try { payload = JSON.parse(line); } catch {}
    }
    if (!payload) {
      try { payload = JSON.parse(raw); } catch {}
    }
    if (payload) {
      const value = payload[process.argv[1]];
      if (value !== undefined && value !== null) {
        process.stdout.write(String(value));
      }
    }
  " "$field"
}

run_service_command() {
  local subcommand="$1"
  shift || true
  (
    cd "$ROOT_DIR"
    node "$ROOT_DIR/dist/infra/cli/index.js" service "$subcommand" --json "$@"
  )
}

install_user_systemd_service() {
  local install_mode result_json detail
  install_mode="${MEMPHIS_BOOTSTRAP_INSTALL_SERVICE:-true}"
  if [[ "${install_mode,,}" == "false" ]]; then
    SYSTEMD_SERVICE_STATUS="disabled by MEMPHIS_BOOTSTRAP_INSTALL_SERVICE=false"
    return
  fi

  if [[ "${CI:-}" == "true" ]]; then
    SYSTEMD_SERVICE_STATUS="skipped in CI"
    return
  fi

  if ! systemd_user_available; then
    SYSTEMD_SERVICE_STATUS="user systemd unavailable"
    return
  fi

  if result_json="$(run_service_command install 2>&1)"; then
    SYSTEMD_SERVICE_PATH="$(printf '%s' "$result_json" | json_field unitPath)"
    detail="$(printf '%s' "$result_json" | json_field detail)"
    SYSTEMD_SERVICE_STATUS="${detail:-installed}"
    return
  fi

  log "service install command failed: $(printf '%s' "$result_json" | tr '\n' ' ' | sed 's/  */ /g')"

  if result_json="$(run_service_command status 2>/dev/null)"; then
    SYSTEMD_SERVICE_PATH="$(printf '%s' "$result_json" | json_field unitPath)"
    detail="$(printf '%s' "$result_json" | json_field detail)"
    SYSTEMD_SERVICE_STATUS="service install command failed; ${detail:-status unavailable}"
  else
    SYSTEMD_SERVICE_STATUS="service install command failed"
  fi
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

  ENSURED_AGENT_PROFILE_PATH="$profile_path"
  log "Ensured agent profile: $profile_path"
}

preview_secret() {
  local value="$1"
  local length="${#value}"
  if [[ "$length" -le 8 ]]; then
    printf '********'
    return
  fi
  printf '%s...%s' "${value:0:4}" "${value: -4}"
}

is_tty() {
  [[ -t 0 ]] && [[ -t 1 ]]
}

vault_initialized() {
  # Default vault location is ${HOME}/.memphis/vault-entries.json (no /vault/
  # subdir — that was a stale guess from before vault-paths.ts centralized
  # the resolution). Match the runtime default in src/infra/storage/vault-paths.ts.
  local entries_path="${MEMPHIS_VAULT_ENTRIES_PATH:-${HOME}/.memphis/vault-entries.json}"
  # Also check legacy path relative to ROOT_DIR (pre-2026-04 vault location)
  local legacy_path="${ROOT_DIR}/data/vault-entries.json"

  if [[ -n "${MEMPHIS_VAULT_ENTRIES_PATH:-}" ]]; then
    [[ -s "$entries_path" ]]
    return $?
  fi

  if [[ -s "$entries_path" ]] || [[ -s "$legacy_path" ]]; then
    return 0
  fi
  return 1
}

detect_ollama_models() {
  local models=""
  models="$(ollama list 2>/dev/null | tail -n +2 | awk '{print $1}' | grep -v '^$' || true)"
  echo "$models"
}

check_ollama_model() {
  local configured_model="${1:-cogito:3b}"
  local available="$2"
  if echo "$available" | grep -q "^${configured_model}$"; then
    return 0
  fi
  return 1
}

main() {
  require_cmd node
  require_cmd npm

  cd "$ROOT_DIR"
  ensure_env_file

  local api_token_status vault_pepper_status
  api_token_status="$(ensure_env_value "MEMPHIS_API_TOKEN" "$(generate_token)")"
  vault_pepper_status="$(ensure_env_value "MEMPHIS_VAULT_PEPPER" "$(generate_pepper)")"
  ensure_env_value "MEMPHIS_AGENT_NAME" "${MEMPHIS_AGENT_NAME:-Memphis Agent}" >/dev/null
  ensure_env_value "MEMPHIS_OWNER_NAME" "${MEMPHIS_OWNER_NAME:-local operator}" >/dev/null
  ensure_env_value "RUST_CHAIN_ENABLED" "true" >/dev/null
  ensure_env_value "RUST_EMBED_PERSIST_ENABLED" "true" >/dev/null
  ensure_env_value "RUST_EMBED_PERSIST_PATH" "./data/embed-index.json" >/dev/null
  if [[ -n "${MEMPHIS_TELEGRAM_BOT_TOKEN:-}" ]]; then
    log "Telegram token detected — auto-enabling channel gateway"
    ensure_env_value "MEMPHIS_CHANNEL_GATEWAY_ENABLED" "true" >/dev/null
  fi
  ensure_agent_profile

  # S17-2: Ollama model auto-detection
  if command -v ollama >/dev/null 2>&1; then
    local available_models
    available_models="$(detect_ollama_models)"
    if [[ -n "$available_models" ]]; then
      local configured_model
      configured_model="$(env_value OLLAMA_MODEL)"
      if [[ -z "${configured_model// }" ]]; then
        configured_model="cogito:3b"
      fi
      if ! echo "$available_models" | grep -q "^${configured_model}$"; then
        local first_model
        first_model="$(echo "$available_models" | head -n1)"
        if [[ -n "$first_model" ]]; then
          log "Configured Ollama model '$configured_model' not available."
          log "Auto-selecting first available model: $first_model"
          ensure_env_value "OLLAMA_MODEL" "$first_model" >/dev/null
        fi
      fi
    else
      log "Ollama found but no models installed. Install models with: ollama pull <model>"
    fi
  fi

  if [[ "$api_token_status" == "generated" ]] || [[ "$vault_pepper_status" == "generated" ]]; then
    echo
    echo "  ┌───────────────────────────────────────────────────────────┐"
    echo "  │  WARNING: New secrets were generated in .env              │"
    echo "  │  Back up .env BEFORE proceeding.                         │"
    echo "  │  Losing MEMPHIS_VAULT_PEPPER makes vault data            │"
    echo "  │  unrecoverable.                                          │"
    echo "  └───────────────────────────────────────────────────────────┘"
    echo
  fi

  mkdir -p "$ROOT_DIR/data" "$HOME/.memphis/embed"

  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    log "Installing npm dependencies"
    npm ci
  fi

  log "Building Memphis"
  npm run build

  log "Initializing workspace context in repo root"
  npm run -s cli -- workspace init . --json >/dev/null

  log "Deferring first-run state formation to memphis init"

  install_user_systemd_service

  log "Bootstrap complete"
  echo
  echo "Mode:"
  echo "  This bootstrap flow is for a cloned Memphis source checkout."
  echo "  GitHub Releases and GitHub Packages publish the package artifact, but the documented full solo-local runtime path remains source-first."
  echo
  echo "Secret awareness:"
  echo "  .env: $ENV_FILE"
  echo "  Agent profile: $ENSURED_AGENT_PROFILE_PATH"
  echo "  MEMPHIS_API_TOKEN ($api_token_status): $(preview_secret "$(env_value MEMPHIS_API_TOKEN)")"
  echo "    Protects authenticated HTTP routes. Clients must send it as Authorization: Bearer <token>."
  echo "  MEMPHIS_VAULT_PEPPER ($vault_pepper_status): $(preview_secret "$(env_value MEMPHIS_VAULT_PEPPER)")"
  echo "    Anchors the local vault bridge. Rotating it breaks access to existing vault data."
  echo "  Save .env securely before migrating this runtime or reusing the vault."
  echo
  echo "Runtime service:"
  echo "  systemd user service: $SYSTEMD_SERVICE_STATUS"
  if [[ -n "$SYSTEMD_SERVICE_PATH" ]]; then
    echo "  Service unit: $SYSTEMD_SERVICE_PATH"
    echo "  Control: systemctl --user status memphis.service"
  fi
  echo
  echo "Next:"
  echo "  1. Run controlled first-run initialization:"
  echo "     npm run -s cli -- init"
  echo "  2. If the service was not auto-enabled, start runtime manually:"
  echo "     npm run dev"
  echo "  3. In another terminal:"
  echo "     npm run -s cli -- tui"
}

main "$@"
