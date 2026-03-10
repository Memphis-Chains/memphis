#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p data
cat > data/mcp-serve-state.json <<'JSON'
{
  "instanceId": "stale-instance",
  "pid": 999999,
  "host": "127.0.0.1",
  "port": 47996,
  "startedAt": "2026-03-10T00:00:00.000Z",
  "mode": "running"
}
JSON

STATUS="$(npm run -s cli -- mcp serve-status --json)"
echo "$STATUS" | grep -q '"running": false'

if [ -f data/mcp-serve-state.json ]; then
  echo "stale state file was not cleared"
  exit 1
fi

echo "[smoke-phase6-native-mcp-serve-stale-state] PASS"
