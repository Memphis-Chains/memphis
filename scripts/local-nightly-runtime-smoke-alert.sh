#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
set -a; source ./.env.production.local; set +a

STAMP="$(date -Is)"
RUN_LOG="/tmp/mv4-local-nightly-smoke.log"
STATE_DIR="${STATE_DIR:-$HOME/.memphis/state}"
ALERT_THROTTLE_SECONDS="${ALERT_THROTTLE_SECONDS:-1800}"
ALERT_SEVERITY="${ALERT_SEVERITY:-critical}"
LAST_ALERT_FILE="$STATE_DIR/mv4-nightly-smoke-last-alert-${ALERT_SEVERITY}.epoch"

mkdir -p "$STATE_DIR"

if npm run -s smoke:ollama-runtime >"$RUN_LOG" 2>&1; then
  echo "[$STAMP] LOCAL_NIGHTLY_SMOKE_OK severity=none"
  exit 0
fi

echo "[$STAMP] LOCAL_NIGHTLY_SMOKE_FAIL severity=${ALERT_SEVERITY}"

NOW_EPOCH="$(date +%s)"
LAST_EPOCH=0
if [[ -f "$LAST_ALERT_FILE" ]]; then
  LAST_EPOCH="$(cat "$LAST_ALERT_FILE" 2>/dev/null || echo 0)"
fi

if (( NOW_EPOCH - LAST_EPOCH < ALERT_THROTTLE_SECONDS )); then
  echo "[$STAMP] ALERT_THROTTLED window=${ALERT_THROTTLE_SECONDS}s"
  exit 1
fi

if [[ -n "${OLLAMA_SMOKE_ALERT_WEBHOOK:-}" ]]; then
  curl -sS -X POST "$OLLAMA_SMOKE_ALERT_WEBHOOK" \
    -H 'content-type: application/json' \
    -d "{\"text\":\"🚨 [${ALERT_SEVERITY}] memphis-v4 local nightly smoke FAILED on $(hostname): $STAMP\"}" >/dev/null || true
fi

echo "$NOW_EPOCH" > "$LAST_ALERT_FILE"
exit 1
