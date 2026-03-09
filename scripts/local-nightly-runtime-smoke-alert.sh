#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
set -a; source ./.env.production.local; set +a

STAMP="$(date -Is)"
RUN_LOG="/tmp/mv4-local-nightly-smoke.log"

if npm run -s smoke:ollama-runtime >"$RUN_LOG" 2>&1; then
  echo "[$STAMP] LOCAL_NIGHTLY_SMOKE_OK"
  exit 0
fi

echo "[$STAMP] LOCAL_NIGHTLY_SMOKE_FAIL"
if [[ -n "${OLLAMA_SMOKE_ALERT_WEBHOOK:-}" ]]; then
  curl -sS -X POST "$OLLAMA_SMOKE_ALERT_WEBHOOK" \
    -H 'content-type: application/json' \
    -d "{\"text\":\"🚨 memphis-v4 local nightly smoke FAILED on $(hostname): $STAMP\"}" >/dev/null || true
fi

exit 1
