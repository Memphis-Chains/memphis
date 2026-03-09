#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
set -a; source ./.env.production.local; set +a

BRIDGE_PORT="${OLLAMA_BRIDGE_PORT:-11435}"
APP_PORT="${SMOKE_APP_PORT:-4430}"

echo "[STEP] Bridge health"
curl -sf "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null
echo "[PASS] bridge up"

echo "[STEP] Guard: model availability in local Ollama"
if command -v ollama >/dev/null 2>&1; then
  ollama list | grep -q '^qwen3.5:2b\b' || {
    echo "[FAIL] qwen3.5:2b missing in ollama list"
    exit 1
  }
  echo "[PASS] model available"
else
  echo "[WARN] ollama CLI missing, skipping local model list guard"
fi

echo "[STEP] App boot"
PORT="$APP_PORT" HOST=127.0.0.1 node dist/index.js >/tmp/mv4-smoke-ollama-runtime.log 2>&1 &
APP_PID=$!
cleanup() { kill "$APP_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${APP_PORT}/health" >/dev/null; then
    break
  fi
  sleep 0.25
done

echo "[STEP] Generate (decentralized-llm/qwen3.5:2b)"
RESP="$(curl -s --max-time 45 \
  -H "Authorization: Bearer ${MEMPHIS_API_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"input":"Napisz jedno krótkie zdanie po polsku.","provider":"decentralized-llm","model":"qwen3.5:2b"}' \
  "http://127.0.0.1:${APP_PORT}/v1/chat/generate")"

echo "$RESP" | grep -q '"providerUsed":"decentralized-llm"'
echo "$RESP" | grep -q '"modelUsed":"qwen3.5:2b"'

echo "[PASS] runtime generate via qwen3.5:2b"
echo "SMOKE_OLLAMA_BRIDGE_RUNTIME_OK"