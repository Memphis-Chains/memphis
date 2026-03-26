#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
TMP_HOME="$TMP_DIR/home"
TMP_ENV="$TMP_DIR/.env"
TMP_BOOTSTRAP_LOG="$TMP_DIR/bootstrap.log"
TMP_SERVER_LOG="$TMP_DIR/server.log"
TMP_DOCTOR="$TMP_DIR/doctor.json"
TMP_HEALTH="$TMP_DIR/health.json"
TMP_VAULT_INIT="$TMP_DIR/vault-init.json"
TMP_VAULT_ADD="$TMP_DIR/vault-add.json"
TMP_VAULT_GET="$TMP_DIR/vault-get.json"
TMP_EMBED_STORE="$TMP_DIR/embed-store.json"
TMP_SEARCH_REBUILD="$TMP_DIR/search-rebuild.json"
TMP_SEARCH="$TMP_DIR/search.json"
TMP_EMBED_SEARCH="$TMP_DIR/embed-search.json"
TMP_CHAT="$TMP_DIR/chat.json"
TMP_TUI="$TMP_DIR/tui.json"
TMP_HTTP_HEALTH="$TMP_DIR/http-health.json"
TMP_HTTP_CHAT="$TMP_DIR/http-chat.json"
TMP_MCP="$TMP_DIR/mcp.json"
TMP_MATRIX="$TMP_DIR/matrix.json"
TMP_VAULT_ENTRIES="$TMP_HOME/.memphis/vault/vault-entries.json"
TMP_VAULT_STATE="$TMP_HOME/.memphis/vault/vault-state.json"
TMP_PORT="${MEMPHIS_RC_DRILL_PORT:-3310}"
REAL_HOME="${HOME}"
SERVER_PID=""
CLI=(npx tsx src/infra/cli/index.ts)
SERVER=(npx tsx src/index.ts)

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

wait_for_http() {
  local url="$1"
  local retries=50
  local delay=0.25

  for _ in $(seq 1 "$retries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

echo "[rc-drill] preparing isolated runtime under $TMP_HOME"
mkdir -p "$TMP_HOME"

export HOME="$TMP_HOME"
export MEMPHIS_SKIP_FIRST_RUN_CHECKS=1
export CARGO_HOME="${CARGO_HOME:-$REAL_HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$REAL_HOME/.rustup}"
export MEMPHIS_ENV_FILE="$TMP_ENV"
export MEMPHIS_VAULT_ENTRIES_PATH="$TMP_VAULT_ENTRIES"
export MEMPHIS_VAULT_STATE_PATH="$TMP_VAULT_STATE"
export MEMPHIS_BOOTSTRAP_INSTALL_SERVICE=false
export MEMPHIS_VAULT_PASSPHRASE="RcDrillPassphrase!123"
export MEMPHIS_VAULT_RECOVERY_QUESTION="pilot"
export MEMPHIS_VAULT_RECOVERY_ANSWER="needle"
export MEMPHIS_AGENT_NAME="RC Drill Agent"
export MEMPHIS_OWNER_NAME="rc-operator"
export MEMPHIS_DATA_DIR="$TMP_HOME/.memphis"

echo "[rc-drill] bootstrap source-checkout runtime"
if ! (cd "$ROOT_DIR" && bash ./scripts/bootstrap.sh >"$TMP_BOOTSTRAP_LOG" 2>&1); then
  cat "$TMP_BOOTSTRAP_LOG" >&2
  exit 1
fi

while IFS='=' read -r key value; do
  [[ -z "${key// }" ]] && continue
  [[ "$key" =~ ^# ]] && continue
  if [[ "$key" == "MEMPHIS_VAULT_ENTRIES_PATH" || "$key" == "MEMPHIS_VAULT_STATE_PATH" || "$key" == "MEMPHIS_DATA_DIR" ]]; then
    continue
  fi
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\".*\"$ ]] || [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  export "$key=$value"
done < "$TMP_ENV"

export HOST="127.0.0.1"
export PORT="$TMP_PORT"
export MEMPHIS_HOST="$HOST"
export MEMPHIS_PORT="$PORT"

echo "[rc-drill] CLI doctor / health / vault / memory / chat"
(cd "$ROOT_DIR" && "${CLI[@]}" doctor --json >"$TMP_DOCTOR" 2>/dev/null) || true
(cd "$ROOT_DIR" && "${CLI[@]}" health --json >"$TMP_HEALTH")
(cd "$ROOT_DIR" && "${CLI[@]}" vault init --passphrase "$MEMPHIS_VAULT_PASSPHRASE" --recovery-question "$MEMPHIS_VAULT_RECOVERY_QUESTION" --recovery-answer "$MEMPHIS_VAULT_RECOVERY_ANSWER" --json >"$TMP_VAULT_INIT")
(cd "$ROOT_DIR" && "${CLI[@]}" vault add --key RC_DRILL_SECRET --value "rc-drill-secret" --json >"$TMP_VAULT_ADD")
(cd "$ROOT_DIR" && "${CLI[@]}" vault get --key RC_DRILL_SECRET --json >"$TMP_VAULT_GET")
(cd "$ROOT_DIR" && "${CLI[@]}" embed store --id RC_DRILL_MEMORY --value "rc drill semantic memory anchor" --json >"$TMP_EMBED_STORE")
(cd "$ROOT_DIR" && "${CLI[@]}" search rebuild --json >"$TMP_SEARCH_REBUILD")
(cd "$ROOT_DIR" && "${CLI[@]}" search --query "semantic memory anchor" --json >"$TMP_SEARCH")
(cd "$ROOT_DIR" && "${CLI[@]}" embed search --query "semantic memory anchor" --top-k 3 --json >"$TMP_EMBED_SEARCH")
(cd "$ROOT_DIR" && "${CLI[@]}" chat --input "Reply with RC_DRILL_OK exactly." --provider local-fallback --json >"$TMP_CHAT")
(cd "$ROOT_DIR" && "${CLI[@]}" tui --check-only --json >"$TMP_TUI")

echo "[rc-drill] start HTTP runtime on $HOST:$PORT"
(cd "$ROOT_DIR" && "${SERVER[@]}" >"$TMP_SERVER_LOG" 2>&1) &
SERVER_PID=$!

if ! wait_for_http "http://$HOST:$PORT/health"; then
  cat "$TMP_SERVER_LOG" >&2
  exit 1
fi

curl -fsS "http://$HOST:$PORT/health" >"$TMP_HTTP_HEALTH"
curl -fsS "http://$HOST:$PORT/v1/chat/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MEMPHIS_API_TOKEN}" \
  -d '{"input":"Reply with RC_HTTP_OK exactly.","provider":"local-fallback"}' >"$TMP_HTTP_CHAT"

echo "[rc-drill] MCP serve-once sanity"
(cd "$ROOT_DIR" && "${CLI[@]}" mcp serve-once --json >"$TMP_MCP")

if [[ "${MEMPHIS_RC_DRILL_MATRIX:-0}" == "1" ]]; then
  echo "[rc-drill] optional Matrix trusted-pilot sanity enabled"
  (cd "$ROOT_DIR" && "${CLI[@]}" setup matrix --json >"$TMP_MATRIX")
else
  printf '{\n  "ok": true,\n  "mode": "matrix-optional",\n  "status": "skipped"\n}\n' >"$TMP_MATRIX"
fi

echo "[rc-drill] bounded package proof"
(cd "$ROOT_DIR" && npm run -s ops:validate-package-artifact)

node - "$TMP_DOCTOR" "$TMP_HEALTH" "$TMP_VAULT_INIT" "$TMP_VAULT_ADD" "$TMP_VAULT_GET" "$TMP_EMBED_STORE" "$TMP_SEARCH_REBUILD" "$TMP_SEARCH" "$TMP_EMBED_SEARCH" "$TMP_CHAT" "$TMP_TUI" "$TMP_HTTP_HEALTH" "$TMP_HTTP_CHAT" "$TMP_MCP" "$TMP_MATRIX" <<'EOF'
const fs = require('node:fs');

const [
  doctorPath,
  healthPath,
  vaultInitPath,
  vaultAddPath,
  vaultGetPath,
  embedStorePath,
  searchRebuildPath,
  searchPath,
  embedSearchPath,
  chatPath,
  tuiPath,
  httpHealthPath,
  httpChatPath,
  mcpPath,
  matrixPath,
] = process.argv.slice(2);

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const doctor = readJson(doctorPath);
const health = readJson(healthPath);
const vaultInit = readJson(vaultInitPath);
const vaultAdd = readJson(vaultAddPath);
const vaultGet = readJson(vaultGetPath);
const embedStore = readJson(embedStorePath);
const searchRebuild = readJson(searchRebuildPath);
const search = readJson(searchPath);
const embedSearch = readJson(embedSearchPath);
const chat = readJson(chatPath);
const tui = readJson(tuiPath);
const httpHealth = readJson(httpHealthPath);
const httpChat = readJson(httpChatPath);
const mcp = readJson(mcpPath);
const matrix = readJson(matrixPath);

if (typeof doctor.ok !== 'boolean' || !Array.isArray(doctor.checks)) {
  throw new Error('rc-drill: doctor output is not a valid JSON report');
}
if (health.status !== 'ok') {
  throw new Error(`rc-drill: CLI health status not ok (${health.status})`);
}
if (vaultInit.ok !== true || typeof vaultInit.vault?.did !== 'string') {
  throw new Error('rc-drill: vault init did not return a usable vault payload');
}
if (vaultAdd.ok !== true || !vaultAdd.entry?.key) {
  throw new Error('rc-drill: vault add did not return a stored entry');
}
if (vaultGet.ok !== true || vaultGet.value !== 'rc-drill-secret') {
  throw new Error('rc-drill: vault get did not return the expected plaintext');
}
if (embedStore.ok !== true || embedStore.data?.success !== true) {
  throw new Error('rc-drill: semantic memory store sanity failed');
}
if (searchRebuild.ok !== true) {
  throw new Error('rc-drill: search rebuild did not return ok=true');
}
if (search.ok !== true || !Array.isArray(search.data?.results)) {
  throw new Error('rc-drill: exact search sanity failed');
}
if (embedSearch.ok !== true || !Array.isArray(embedSearch.data?.hits)) {
  throw new Error('rc-drill: semantic recall sanity failed');
}
if (!embedSearch.data.hits.some((hit) => typeof hit?.id === 'string' && hit.id.includes('RC_DRILL_MEMORY'))) {
  throw new Error('rc-drill: semantic recall did not return the seeded memory');
}
if (typeof chat.output !== 'string' || chat.providerUsed !== 'local-fallback') {
  throw new Error('rc-drill: CLI chat sanity failed');
}
if (tui.mode !== 'check-only' || tui.ok !== true || !Array.isArray(tui.screens)) {
  throw new Error('rc-drill: Rust TUI check-only report invalid');
}
if (!tui.screens.includes('Chat') || !tui.screens.includes('Vault')) {
  throw new Error('rc-drill: Rust TUI report missing expected screens');
}
if (httpHealth.status !== 'healthy') {
  throw new Error(`rc-drill: HTTP /health not healthy (${httpHealth.status})`);
}
if (typeof httpChat.output !== 'string' || httpChat.providerUsed !== 'local-fallback') {
  throw new Error('rc-drill: HTTP chat sanity failed');
}
if (mcp.ok !== true || mcp.mode !== 'mcp-serve-once' || !mcp.response?.result) {
  throw new Error('rc-drill: MCP serve-once sanity failed');
}
if (!['skipped', 'configured', 'ready'].includes(matrix.status ?? '')) {
  if (!(matrix.ok === true && matrix.pilotReady === false) && !(matrix.ok === true && matrix.pilotReady === true)) {
    throw new Error('rc-drill: Matrix optional sanity output was not truthful JSON');
  }
}
EOF

echo "[rc-drill] PASS"
