#!/usr/bin/env bash
set -euo pipefail

UNIT="ollama-compat-bridge.service"
HEALTH_URL="http://127.0.0.1:11435/health"

echo "[STEP] Ensure services are running"
systemctl --user enable --now "$UNIT" >/dev/null
systemctl --user enable --now ollama-bridge-healthcheck.timer >/dev/null

echo "[STEP] Simulate failure (stop bridge)"
systemctl --user stop "$UNIT"

echo "[STEP] Trigger healthcheck service 3x (to reach auto-restart threshold)"
for _ in $(seq 1 3); do
  systemctl --user start ollama-bridge-healthcheck.service || true
  sleep 1
done

echo "[STEP] Verify recovery"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null; then
    echo "[PASS] bridge recovered"
    break
  fi
  sleep 1
done
curl -fsS "$HEALTH_URL" >/dev/null

echo "[STEP] Runtime smoke"
npm run smoke:ollama-runtime >/dev/null

echo "DRILL_OLLAMA_BRIDGE_RECOVERY_OK"
