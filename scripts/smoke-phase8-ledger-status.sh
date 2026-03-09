#!/usr/bin/env bash
set -euo pipefail

npm run -s test:smoke:phase8-closure-ledger >/tmp/mv4-ledger-status-smoke.out
OUT="$(./scripts/phase8-ledger-status.sh)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"entries": '
echo "$OUT" | grep -q '"closureChecksum": '

echo "[smoke-phase8-ledger-status] PASS"
