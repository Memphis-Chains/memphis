#!/usr/bin/env bash
set -euo pipefail

SCHEMA="$(env DEFAULT_PROVIDER=shared-llm SHARED_LLM_API_BASE=https://api.openai.com/v1 SHARED_LLM_API_KEY=smoke npm run -s cli -- mcp --schema --json)"
echo "$SCHEMA" | grep -q '"memphis.ask"'

aenv(){ env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true "$@"; }
REQ='{"jsonrpc":"2.0","id":"serve-schema-1","method":"memphis.ask","params":{"input":"serve schema smoke","provider":"local-fallback"}}'
OUT="$(aenv npm run -s cli -- mcp serve-once --input "$REQ" --json)"

echo "$OUT" | grep -q '"mode": "mcp-serve-once"'
echo "$OUT" | grep -q '"jsonrpc": "2.0"'

echo "[smoke-phase6-native-mcp-serve-schema] PASS"
