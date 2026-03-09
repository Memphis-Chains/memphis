#!/usr/bin/env bash
set -euo pipefail

OUT="$(env DEFAULT_PROVIDER=shared-llm SHARED_LLM_API_BASE=https://api.openai.com/v1 SHARED_LLM_API_KEY=smoke npm run -s cli -- mcp --schema --json)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"memphis.ask"'
echo "$OUT" | grep -q '"-32700"'
echo "$OUT" | grep -q '"-32601"'
echo "$OUT" | grep -q '"-32602"'

echo "[smoke-phase6-native-mcp-schema] PASS"
