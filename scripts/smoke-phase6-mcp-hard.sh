#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="/tmp/mv4-phase6-hard"
mkdir -p "$OUT_DIR"

REQ_PATH="$OUT_DIR/request.json"
RESP_PATH="$OUT_DIR/response.json"
REPORT_PATH="$OUT_DIR/report.json"

cat > "$REQ_PATH" <<JSON
{
  "jsonrpc": "2.0",
  "id": "phase6-hard-1",
  "method": "memphis.ask",
  "params": {
    "input": "Phase6 hard MCP gate: return deterministic acknowledgement",
    "provider": "local-fallback"
  }
}
JSON

START_MS="$(date +%s%3N)"
RESP="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- ask --input "Phase6 hard MCP gate: return deterministic acknowledgement" --provider local-fallback --json)"
END_MS="$(date +%s%3N)"
LAT_MS="$((END_MS - START_MS))"

printf '%s\n' "$RESP" > "$RESP_PATH"

# strict JSON checks
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(!j.id) throw new Error("missing id");
if(!j.output || typeof j.output!=="string") throw new Error("missing output");
if(!j.providerUsed) throw new Error("missing providerUsed");
if(j.timingMs === undefined || j.timingMs < 0) throw new Error("invalid timingMs");
if(!j.trace || !Array.isArray(j.trace.attempts) || j.trace.attempts.length===0) throw new Error("missing trace attempts");
if(!j.trace.attempts.some(a => typeof a.latencyMs === "number" && a.latencyMs > 0)) throw new Error("no positive attempt latency");
' "$RESP_PATH"

# local gate thresholds
if [ "$LAT_MS" -gt 15000 ]; then
  echo "hard-gate latency too high: ${LAT_MS}ms" >&2
  exit 1
fi

cat > "$REPORT_PATH" <<JSON
{
  "ok": true,
  "mode": "phase6-mcp-hard",
  "requestPath": "$REQ_PATH",
  "responsePath": "$RESP_PATH",
  "latencyWallMs": $LAT_MS,
  "thresholdMs": 15000
}
JSON

echo "[smoke-phase6-mcp-hard] PASS"
