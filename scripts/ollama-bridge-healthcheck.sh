#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:11435/health}"
UNIT_NAME="${UNIT_NAME:-ollama-compat-bridge.service}"
STATE_DIR="${STATE_DIR:-$HOME/.memphis/state}"
STATE_FILE="$STATE_DIR/ollama-bridge-health-fail-count"
MAX_FAILS="${MAX_FAILS:-3}"
TIMEOUT_SECS="${TIMEOUT_SECS:-3}"

mkdir -p "$STATE_DIR"
FAIL_COUNT=0
if [[ -f "$STATE_FILE" ]]; then
  FAIL_COUNT="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
fi

if curl -fsS --max-time "$TIMEOUT_SECS" "$BRIDGE_URL" >/dev/null; then
  echo 0 > "$STATE_FILE"
  echo "BRIDGE_HEALTH_OK"
  exit 0
fi

FAIL_COUNT=$((FAIL_COUNT + 1))
echo "$FAIL_COUNT" > "$STATE_FILE"
echo "BRIDGE_HEALTH_FAIL count=$FAIL_COUNT"

if [[ "$FAIL_COUNT" -ge "$MAX_FAILS" ]]; then
  echo "RECOVERY_TRIGGERED restarting $UNIT_NAME"
  systemctl --user restart "$UNIT_NAME"
  echo 0 > "$STATE_FILE"
fi
