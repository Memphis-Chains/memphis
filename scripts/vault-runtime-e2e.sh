#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASS() { echo "[PASS] $1"; }
FAIL() { echo "[FAIL] $1"; exit 1; }
STEP() { echo "[STEP] $1"; }

: "${MEMPHIS_VAULT_PEPPER:?MEMPHIS_VAULT_PEPPER is required (min 12 chars)}"

PORT="${PORT:-$((3000 + RANDOM % 2000))}"
HOST="${HOST:-127.0.0.1}"
BASE_URL="http://${HOST}:${PORT}"
TMP_ENTRIES="$(mktemp /tmp/mv4-vault-entries.XXXXXX.json)"
TMP_BRIDGE="$(mktemp /tmp/mv4-vault-bridge.XXXXXX.cjs)"
LOG_FILE="$(mktemp /tmp/mv4-vault-runtime.XXXXXX.log)"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill -TERM -- "-$SERVER_PID" >/dev/null 2>&1 || kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$TMP_ENTRIES" "$TMP_BRIDGE" "$LOG_FILE"
}
trap cleanup EXIT

AUTH_HEADER=()
if [ -n "${MEMPHIS_API_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${MEMPHIS_API_TOKEN}")
fi

STEP "Preparing mock rust vault bridge"
cat >"$TMP_BRIDGE" <<'EOF'
module.exports = {
  vault_init: (requestJson) => JSON.stringify({ ok: true, data: { version: 1, did: 'did:memphis:runtime' } }),
  vault_encrypt: (key, plaintext) => JSON.stringify({ ok: true, data: { key, encrypted: 'plain:' + plaintext, iv: 'runtime-iv' } }),
  vault_decrypt: (entryJson) => {
    const entry = JSON.parse(entryJson);
    return JSON.stringify({ ok: true, data: { plaintext: String(entry.encrypted || '').replace(/^plain:/, '') } });
  }
};
EOF
PASS "mock rust vault bridge"

STEP "Starting memphis-v4 HTTP server on ${HOST}:${PORT}"
setsid env DEFAULT_PROVIDER="${DEFAULT_PROVIDER:-local-fallback}" RUST_CHAIN_ENABLED=true RUST_CHAIN_BRIDGE_PATH="$TMP_BRIDGE" MEMPHIS_VAULT_ENTRIES_PATH="$TMP_ENTRIES" HOST="$HOST" PORT="$PORT" MEMPHIS_VAULT_PEPPER="$MEMPHIS_VAULT_PEPPER" ./node_modules/.bin/tsx src/index.ts >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

STEP "Waiting for /health"
for i in {1..40}; do
  if curl -sS "${BASE_URL}/health" >/dev/null 2>&1; then
    PASS "server is up"
    break
  fi
  sleep 0.5
  if [ "$i" -eq 40 ]; then
    cat "$LOG_FILE"
    FAIL "server did not start"
  fi
done

STEP "Vault init"
INIT_BODY='{"passphrase":"VeryStrongPassphrase!123","recovery_question":"pet name?","recovery_answer":"nori"}'
INIT_RES="$(curl -sS -X POST "${BASE_URL}/v1/vault/init" "${AUTH_HEADER[@]}" -H 'content-type: application/json' -d "$INIT_BODY")"
echo "$INIT_RES" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.ok||!d.vault||!d.vault.did) process.exit(1);' || FAIL "vault init failed"
PASS "vault init"

STEP "Vault encrypt"
ENC_BODY='{"key":"runtime-key","plaintext":"night-runtime-secret"}'
ENC_RES="$(curl -sS -X POST "${BASE_URL}/v1/vault/encrypt" "${AUTH_HEADER[@]}" -H 'content-type: application/json' -d "$ENC_BODY")"
ENTRY_JSON="$(echo "$ENC_RES" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.ok||!d.entry) process.exit(1); process.stdout.write(JSON.stringify(d.entry));')" || FAIL "vault encrypt failed"
PASS "vault encrypt"

STEP "Vault decrypt"
DEC_BODY="$(printf '{"entry":%s}' "$ENTRY_JSON")"
DEC_RES="$(curl -sS -X POST "${BASE_URL}/v1/vault/decrypt" "${AUTH_HEADER[@]}" -H 'content-type: application/json' -d "$DEC_BODY")"
echo "$DEC_RES" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.ok||d.plaintext!=="night-runtime-secret") process.exit(1);' || FAIL "vault decrypt mismatch"
PASS "vault decrypt"

STEP "Vault entries integrity"
LIST_RES="$(curl -sS "${BASE_URL}/v1/vault/entries" "${AUTH_HEADER[@]}")"
echo "$LIST_RES" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!d.ok||!Array.isArray(d.entries)||d.entries.length<1) process.exit(1); if(!d.entries[0].fingerprint||d.entries[0].integrityOk!==true) process.exit(1);' || FAIL "vault entries integrity failed"
PASS "vault entries integrity"

echo "E2E_VAULT_RUNTIME_OK"
