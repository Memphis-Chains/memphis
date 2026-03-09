#!/usr/bin/env bash
set -euo pipefail

echo "[STEP] Prune temporary runtime logs older than 7 days"
find /tmp -maxdepth 1 -type f \( -name 'mv4-*' -o -name 'ollama-compat-bridge.log' \) -mtime +7 -print -delete || true

echo "[STEP] Vacuum user journal to 14 days (best effort)"
journalctl --user --vacuum-time=14d || true

echo "RUNTIME_LOG_MAINTENANCE_OK"
