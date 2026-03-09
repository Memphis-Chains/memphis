#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASS() { echo "[PASS] $1"; }
FAIL() { echo "[FAIL] $1"; exit 1; }
STEP() { echo "[STEP] $1"; }

: "${MEMPHIS_VAULT_PEPPER:?MEMPHIS_VAULT_PEPPER is required (min 12 chars)}"

PORT="${PORT:-$((3400 + RANDOM % 300))}"
HOST="127.0.0.1"
BASE_URL="http://${HOST}:${PORT}"
TMP_ENTRIES="$(mktemp /tmp/mv4-vault-drill-entries.XXXXXX.json)"
SERVER_LOG="$(mktemp /tmp/mv4-vault-drill.XXXXXX.log)"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill -TERM -- "-$SERVER_PID" >/dev/null 2>&1 || kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$TMP_ENTRIES" "$SERVER_LOG"
}
trap cleanup EXIT

AUTH_HEADER=()
if [[ -n "${MEMPHIS_API_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${MEMPHIS_API_TOKEN}")
fi

STEP "Start app with missing rust bridge (degraded mode expected)"
setsid env DEFAULT_PROVIDER="${DEFAULT_PROVIDER:-local-fallback}" \
  RUST_CHAIN_ENABLED=true \
  RUST_CHAIN_BRIDGE_PATH="/tmp/missing-vault-bridge.node" \
  MEMPHIS_VAULT_ENTRIES_PATH="$TMP_ENTRIES" \
  MEMPHIS_VAULT_PEPPER="$MEMPHIS_VAULT_PEPPER" \
  HOST="$HOST" PORT="$PORT" \
  ./node_modules/.bin/tsx src/index.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for i in {1..40}; do
  if curl -sS "${BASE_URL}/health" >/dev/null 2>&1; then
    PASS "server up"
    break
  fi
  sleep 0.5
  [[ "$i" -eq 40 ]] && { cat "$SERVER_LOG"; FAIL "server did not start"; }
done

STEP "Verify vault path fails safely before recovery"
RES_DEGRADED="$(curl -sS -X POST "${BASE_URL}/v1/vault/init" "${AUTH_HEADER[@]}" -H 'content-type: application/json' -d '{"passphrase":"VeryStrongPassphrase!123","recovery_question":"pet?","recovery_answer":"nori"}')"
echo "$RES_DEGRADED" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if(d.ok===true) process.exit(1);' || FAIL "vault should fail while bridge missing"
PASS "vault fails safely without bridge"

STEP "Run recovery path via deterministic vault runtime E2E"
RECOVERY_PORT="$((3700 + RANDOM % 200))"
MEMPHIS_VAULT_PEPPER="$MEMPHIS_VAULT_PEPPER" PORT="$RECOVERY_PORT" ./scripts/vault-runtime-e2e.sh
PASS "vault runtime recovered and E2E passed"

echo "DRILL_VAULT_RUNTIME_RECOVERY_OK"
