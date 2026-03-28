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
TMP_CHAT_OLLAMA="$TMP_DIR/chat-ollama.json"
TMP_TUI="$TMP_DIR/tui.json"
TMP_TUI_COMMAND="$TMP_DIR/tui-command.json"
TMP_HTTP_HEALTH="$TMP_DIR/http-health.json"
TMP_HTTP_CHAT="$TMP_DIR/http-chat.json"
TMP_HTTP_TURN_SEARCH="$TMP_DIR/http-turn-search.json"
TMP_HTTP_JOURNAL="$TMP_DIR/http-journal.json"
TMP_HTTP_SEARCH="$TMP_DIR/http-search.json"
TMP_HTTP_CHAT_OLLAMA="$TMP_DIR/http-chat-ollama.json"
TMP_MCP="$TMP_DIR/mcp.json"
TMP_MATRIX="$TMP_DIR/matrix.json"
TMP_OLLAMA="$TMP_DIR/ollama.json"
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
export DEFAULT_PROVIDER="local-fallback"
export RUST_EMBED_MODE="local"
export OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
unset RUST_EMBED_PROVIDER_URL
unset RUST_EMBED_PROVIDER_API_KEY
unset RUST_EMBED_PROVIDER_MODEL

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
(cd "$ROOT_DIR" && "${CLI[@]}" tui --run-command "/config tools list" --json >"$TMP_TUI_COMMAND")

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
  -d '{"input":"Reply with RC_HTTP_OK exactly. Remember RC_HTTP_TURN_MEMORY anchor.","provider":"local-fallback","sessionId":"rc-http-turn"}' >"$TMP_HTTP_CHAT"
curl -fsS "http://$HOST:$PORT/api/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MEMPHIS_API_TOKEN}" \
  -d '{"query":"RC_HTTP_TURN_MEMORY anchor","limit":5,"chain":"journal"}' >"$TMP_HTTP_TURN_SEARCH"
curl -fsS "http://$HOST:$PORT/api/journal" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MEMPHIS_API_TOKEN}" \
  -d '{"content":"RC_HTTP_CHAIN_MEMORY anchor","tags":["rc-drill","journal"],"chain":"journal"}' >"$TMP_HTTP_JOURNAL"
curl -fsS "http://$HOST:$PORT/api/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MEMPHIS_API_TOKEN}" \
  -d '{"query":"RC_HTTP_CHAIN_MEMORY anchor","limit":5,"chain":"journal"}' >"$TMP_HTTP_SEARCH"

if curl -fsS "${OLLAMA_URL%/}/api/tags" >/dev/null 2>&1; then
  echo "[rc-drill] optional Ollama-local provider sanity"
  (cd "$ROOT_DIR" && "${CLI[@]}" chat --input "Reply with RC_OLLAMA_OK exactly." --provider ollama --json >"$TMP_CHAT_OLLAMA")
  curl -fsS "http://$HOST:$PORT/v1/chat/generate" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${MEMPHIS_API_TOKEN}" \
    -d '{"input":"Reply with RC_HTTP_OLLAMA_OK exactly.","provider":"ollama"}' >"$TMP_HTTP_CHAT_OLLAMA"
  printf '{\n  "ok": true,\n  "status": "ready",\n  "provider": "ollama"\n}\n' >"$TMP_OLLAMA"
else
  printf '{\n  "ok": true,\n  "status": "skipped",\n  "provider": "ollama",\n  "reason": "ollama-unreachable"\n}\n' >"$TMP_OLLAMA"
  printf '{\n  "ok": true,\n  "status": "skipped",\n  "provider": "ollama"\n}\n' >"$TMP_CHAT_OLLAMA"
  printf '{\n  "ok": true,\n  "status": "skipped",\n  "provider": "ollama"\n}\n' >"$TMP_HTTP_CHAT_OLLAMA"
fi

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

node - "$TMP_DOCTOR" "$TMP_HEALTH" "$TMP_VAULT_INIT" "$TMP_VAULT_ADD" "$TMP_VAULT_GET" "$TMP_EMBED_STORE" "$TMP_SEARCH_REBUILD" "$TMP_SEARCH" "$TMP_EMBED_SEARCH" "$TMP_CHAT" "$TMP_CHAT_OLLAMA" "$TMP_TUI" "$TMP_TUI_COMMAND" "$TMP_HTTP_HEALTH" "$TMP_HTTP_CHAT" "$TMP_HTTP_TURN_SEARCH" "$TMP_HTTP_JOURNAL" "$TMP_HTTP_SEARCH" "$TMP_HTTP_CHAT_OLLAMA" "$TMP_MCP" "$TMP_MATRIX" "$TMP_OLLAMA" <<'EOF'
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
  chatOllamaPath,
  tuiPath,
  tuiCommandPath,
  httpHealthPath,
  httpChatPath,
  httpTurnSearchPath,
  httpJournalPath,
  httpSearchPath,
  httpChatOllamaPath,
  mcpPath,
  matrixPath,
  ollamaPath,
] = process.argv.slice(2);

const readJson = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  try {
    return JSON.parse(raw);
  } catch (error) {
    const objectStart = raw.lastIndexOf('\n{');
    const arrayStart = raw.lastIndexOf('\n[');
    const start =
      objectStart >= 0 ? objectStart + 1 : arrayStart >= 0 ? arrayStart + 1 : raw.startsWith('{') || raw.startsWith('[') ? 0 : -1;
    if (start >= 0) {
      return JSON.parse(raw.slice(start));
    }
    throw error;
  }
};

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
const chatOllama = readJson(chatOllamaPath);
const tui = readJson(tuiPath);
const tuiCommand = readJson(tuiCommandPath);
const httpHealth = readJson(httpHealthPath);
const httpChat = readJson(httpChatPath);
const httpTurnSearch = readJson(httpTurnSearchPath);
const httpJournal = readJson(httpJournalPath);
const httpSearch = readJson(httpSearchPath);
const httpChatOllama = readJson(httpChatOllamaPath);
const mcp = readJson(mcpPath);
const matrix = readJson(matrixPath);
const ollama = readJson(ollamaPath);

if (typeof doctor.ok !== 'boolean' || !Array.isArray(doctor.checks)) {
  throw new Error('rc-drill: doctor output is not a valid JSON report');
}
if (health.status !== 'ok') {
  throw new Error(`rc-drill: CLI health status not ok (${health.status})`);
}
if (health.runtimeStatus !== 'healthy') {
  throw new Error(`rc-drill: CLI runtime health not healthy (${health.runtimeStatus})`);
}
if (health.runtime?.offline?.activeMode !== 'local-fallback') {
  throw new Error(`rc-drill: CLI runtime activeMode is not local-fallback (${health.runtime?.offline?.activeMode})`);
}
if (!health.runtime?.offline?.supportedModes?.includes('local-fallback')) {
  throw new Error('rc-drill: CLI runtime does not report local-fallback support');
}
if (health.runtime?.chainMemory?.status === 'missing') {
  throw new Error('rc-drill: CLI runtime reports missing chain memory root');
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
if (!search.data.results.some((hit) => hit?.chain === 'journal' && String(hit?.summary ?? '').includes('semantic memory anchor'))) {
  throw new Error('rc-drill: exact search did not resolve the journal-backed durable memory');
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
if (
  tui.mode !== 'check-only' ||
  tui.ok !== true ||
  tui.uiMode !== 'single-view' ||
  tui.rendererMode !== 'diff-lines' ||
  !Array.isArray(tui.surfaces)
) {
  throw new Error('rc-drill: Rust TUI check-only report invalid');
}
if (
  !tui.surfaces.includes('Chat') ||
  !tui.surfaces.includes('Vault')
) {
  throw new Error('rc-drill: Rust TUI report missing expected native surfaces');
}
if (
  tuiCommand.mode !== 'run-command' ||
  tuiCommand.command !== '/config tools list' ||
  tuiCommand.ok !== true ||
  tuiCommand.route !== 'host' ||
  !Array.isArray(tuiCommand.transcript)
) {
  throw new Error('rc-drill: Rust TUI host-backed command proof invalid');
}
if (!tuiCommand.transcript.some((line) => typeof line?.content === 'string' && line.content.includes('Config tools list'))) {
  throw new Error('rc-drill: Rust TUI host-backed proof did not render the expected transcript section');
}
if (httpHealth.status !== 'healthy') {
  throw new Error(`rc-drill: HTTP /health not healthy (${httpHealth.status})`);
}
if (httpHealth.runtime?.offline?.activeMode !== 'local-fallback') {
  throw new Error(`rc-drill: HTTP /health activeMode is not local-fallback (${httpHealth.runtime?.offline?.activeMode})`);
}
if (typeof httpChat.output !== 'string' || httpChat.providerUsed !== 'local-fallback') {
  throw new Error('rc-drill: HTTP chat sanity failed');
}
if (httpTurnSearch.ok !== true || !Array.isArray(httpTurnSearch.results?.hits)) {
  throw new Error('rc-drill: HTTP turn-backed exact search sanity failed');
}
if (!httpTurnSearch.results.hits.some((hit) => hit?.chain === 'journal' && String(hit?.content ?? '').includes('RC_HTTP_TURN_MEMORY anchor'))) {
  throw new Error('rc-drill: HTTP chat turn did not persist searchable chain-backed memory');
}
if (httpJournal.ok !== true || typeof httpJournal.index !== 'number') {
  throw new Error('rc-drill: HTTP journal append sanity failed');
}
if (httpSearch.ok !== true || !Array.isArray(httpSearch.results?.hits)) {
  throw new Error('rc-drill: HTTP exact search sanity failed');
}
if (!httpSearch.results.hits.some((hit) => hit?.chain === 'journal' && String(hit?.content ?? '').includes('RC_HTTP_CHAIN_MEMORY anchor'))) {
  throw new Error('rc-drill: HTTP exact search did not return the journal-backed runtime write');
}
if (ollama.status === 'ready') {
  if (typeof chatOllama.output !== 'string' || chatOllama.providerUsed !== 'ollama') {
    throw new Error('rc-drill: CLI Ollama-local sanity failed');
  }
  if (typeof httpChatOllama.output !== 'string' || httpChatOllama.providerUsed !== 'ollama') {
    throw new Error('rc-drill: HTTP Ollama-local sanity failed');
  }
} else if (ollama.status !== 'skipped') {
  throw new Error(`rc-drill: unexpected Ollama probe status (${ollama.status})`);
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
