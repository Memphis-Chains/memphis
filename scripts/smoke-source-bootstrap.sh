#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
TMP_HOME="$TMP_DIR/home"
TMP_ENV="$TMP_DIR/.env"
TMP_LOG="$TMP_DIR/bootstrap.log"
TMP_GUIDE="$TMP_DIR/guide.json"
TMP_HEALTH="$TMP_DIR/health.json"
TMP_VAULT_LIST="$TMP_DIR/vault-list.json"
TMP_VAULT_ENTRIES="$TMP_HOME/.memphis/vault/vault-entries.json"
REAL_HOME="${HOME}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_HOME"

export HOME="$TMP_HOME"
export CARGO_HOME="${CARGO_HOME:-$REAL_HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$REAL_HOME/.rustup}"
export MEMPHIS_ENV_FILE="$TMP_ENV"
export MEMPHIS_VAULT_ENTRIES_PATH="$TMP_VAULT_ENTRIES"
export MEMPHIS_BOOTSTRAP_INSTALL_SERVICE=false
export MEMPHIS_VAULT_PASSPHRASE="SmokePassphrase!123"
export MEMPHIS_VAULT_RECOVERY_QUESTION="pet"
export MEMPHIS_VAULT_RECOVERY_ANSWER="nori"
export MEMPHIS_AGENT_NAME="Smoke Agent"
export MEMPHIS_OWNER_NAME="smoke-operator"

if ! (cd "$ROOT_DIR" && bash ./scripts/bootstrap.sh >"$TMP_LOG" 2>&1); then
  cat "$TMP_LOG" >&2
  exit 1
fi

(cd "$ROOT_DIR" && node ./dist/infra/cli/index.js guide --json >"$TMP_GUIDE")
(cd "$ROOT_DIR" && node ./dist/infra/cli/index.js health --json >"$TMP_HEALTH")
(cd "$ROOT_DIR" && node ./dist/infra/cli/index.js vault list --json >"$TMP_VAULT_LIST")

node - "$TMP_ENV" "$TMP_HOME" "$TMP_GUIDE" "$TMP_HEALTH" "$TMP_VAULT_LIST" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const [envPath, homeDir, guidePath, healthPath, vaultListPath] = process.argv.slice(2);
const envText = fs.readFileSync(envPath, 'utf8');
const guide = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
const vaultList = JSON.parse(fs.readFileSync(vaultListPath, 'utf8'));
const agentProfilePath = path.join(homeDir, '.memphis', 'config', 'agent-profile.json');

if (!envText.includes('MEMPHIS_API_TOKEN=')) {
  throw new Error('bootstrap smoke: env file missing MEMPHIS_API_TOKEN');
}
if (!envText.includes('MEMPHIS_VAULT_PEPPER=')) {
  throw new Error('bootstrap smoke: env file missing MEMPHIS_VAULT_PEPPER');
}
if (!envText.includes('RUST_CHAIN_ENABLED=true')) {
  throw new Error('bootstrap smoke: env file missing RUST_CHAIN_ENABLED=true');
}
if (!fs.existsSync(agentProfilePath)) {
  throw new Error(`bootstrap smoke: agent profile missing at ${agentProfilePath}`);
}
if (vaultList.ok !== true || !Array.isArray(vaultList.entries)) {
  throw new Error('bootstrap smoke: vault list output missing ok=true entries array');
}
if (!Array.isArray(guide.sections) || guide.sections.length === 0) {
  throw new Error('bootstrap smoke: guide output missing sections');
}
if (health.status !== 'ok') {
  throw new Error(`bootstrap smoke: health status not ok (${health.status})`);
}
EOF

echo "[source-bootstrap-smoke] PASS"
