#!/usr/bin/env bash
set -euo pipefail

if env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input '{bad json' --json >/tmp/mv4-mcp-malformed.out 2>&1; then
  echo "malformed mcp payload unexpectedly passed" >&2
  exit 1
fi

grep -qi 'must be valid JSON-RPC payload' /tmp/mv4-mcp-malformed.out

echo "[smoke-phase6-native-mcp-malformed] PASS"
