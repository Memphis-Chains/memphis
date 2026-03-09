#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm run -s test:smoke:phase8-native-transport >/tmp/mv4-phase8-native-transport.out
npm run -s test:smoke:phase8-closure-ledger-checksum >/tmp/mv4-phase8-ledger-checksum.out
OUT="$(npm run -s ops:phase8-ledger-status)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"entries": '

echo "[smoke-phase8-native-transport-multinode] PASS"
