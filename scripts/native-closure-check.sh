#!/usr/bin/env bash
set -euo pipefail

npm run -s test:smoke:phase5-transition
npm run -s test:smoke:phase6-native-mcp-hard
npm run -s test:smoke:phase6-native-mcp-negative
npm run -s test:smoke:phase6-native-mcp-malformed
npm run -s test:smoke:phase8-native-ed25519
npm run -s test:smoke:phase8-native-ed25519-verify
npm run -s test:smoke:phase8-native-hard
npm run -s test:smoke:phase8-native-transport
npm run -s test:smoke:phase8-closure-artifact

echo "[native-closure-check] PASS"
