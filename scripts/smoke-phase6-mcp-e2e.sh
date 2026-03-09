#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REQ='{"jsonrpc":"2.0","id":"phase6-e2e-1","method":"memphis.ask","params":{"input":"MCP E2E smoke: say ok"}}'

echo "$REQ" >/tmp/mv4-phase6-mcp-request.json

RESP="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- ask --input "MCP E2E smoke: say ok" --provider local-fallback --json)"

echo "$RESP" >/tmp/mv4-phase6-mcp-response.json

echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(!j.id||!j.output){process.exit(1)}; console.log("ok")})'

echo "[smoke-phase6-mcp-e2e] PASS"
