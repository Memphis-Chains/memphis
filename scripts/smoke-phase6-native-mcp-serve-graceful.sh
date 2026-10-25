#!/usr/bin/env bash
set -euo pipefail

ERR_FILE="/tmp/mv4-mcp-graceful.err"
OUT_FILE="/tmp/mv4-mcp-graceful.out"

# Stdout belongs to the JSON-RPC stream when --transport stdio is in effect,
# so lifecycle status is expected on stderr. Capture both separately and assert
# the split: JSON-RPC frames on stdout, lifecycle status on stderr.
env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true \
  npm run -s cli -- mcp serve --transport stdio --duration-ms 300 --json \
  >"$OUT_FILE" 2>"$ERR_FILE"

# Lifecycle status must be present, and on stderr.
grep -q '"mode": "mcp-serve"' "$ERR_FILE"
grep -q '"mode": "mcp-serve-stopped"' "$ERR_FILE"
grep -q '"reason": "timeout"' "$ERR_FILE"

# The regression this gate exists for: lifecycle status must never contaminate
# the protocol stream. With no client attached there is no JSON-RPC output at
# all, so stdout must be completely empty.
if [ -s "$OUT_FILE" ]; then
  echo "stdout carried non-JSON-RPC output:" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

echo "[smoke-phase6-native-mcp-serve-graceful] PASS"
