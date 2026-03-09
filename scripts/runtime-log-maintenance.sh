#!/usr/bin/env bash
set -euo pipefail

OUTPUT_MODE="text"
if [[ "${1:-}" == "--json" ]]; then
  OUTPUT_MODE="json"
fi

TMP_PRUNED="$(find /tmp -maxdepth 1 -type f \( -name 'mv4-*' -o -name 'ollama-compat-bridge.log' \) -mtime +7 -print | wc -l | tr -d ' ')"
find /tmp -maxdepth 1 -type f \( -name 'mv4-*' -o -name 'ollama-compat-bridge.log' \) -mtime +7 -delete || true

JOURNAL_OK=true
if ! journalctl --user --vacuum-time=14d >/dev/null 2>&1; then
  JOURNAL_OK=false
fi

if [[ "$OUTPUT_MODE" == "json" ]]; then
  printf '{"ok":true,"tmpLogsPruned":%s,"journalVacuumOk":%s,"journalRetentionDays":14,"tmpRetentionDays":7,"result":"RUNTIME_LOG_MAINTENANCE_OK"}\n' "$TMP_PRUNED" "$JOURNAL_OK"
  exit 0
fi

echo "[STEP] Prune temporary runtime logs older than 7 days"
echo "[INFO] pruned files: $TMP_PRUNED"

echo "[STEP] Vacuum user journal to 14 days (best effort)"
if [[ "$JOURNAL_OK" == "true" ]]; then
  echo "[PASS] journal vacuum applied"
else
  echo "[WARN] journal vacuum skipped/failed (permissions/runtime)"
fi

echo "RUNTIME_LOG_MAINTENANCE_OK"
