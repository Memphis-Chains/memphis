#!/usr/bin/env bash
set -euo pipefail

BAD_METHOD='{"jsonrpc":"2.0","id":"x1","method":"memphis.bad","params":{"input":"x"}}'
if env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input "$BAD_METHOD" --json >/tmp/mv4-mcp-neg.out 2>&1; then
  echo "negative test failed: bad method should error" >&2
  exit 1
fi
grep -qi 'unsupported method' /tmp/mv4-mcp-neg.out

BAD_INPUT='{"jsonrpc":"2.0","id":"x2","method":"memphis.ask","params":{"input":""}}'
if env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input "$BAD_INPUT" --json >/tmp/mv4-mcp-neg2.out 2>&1; then
  echo "negative test failed: empty input should error" >&2
  exit 1
fi
grep -qi 'missing params.input' /tmp/mv4-mcp-neg2.out

echo "[smoke-phase6-native-mcp-negative] PASS"
