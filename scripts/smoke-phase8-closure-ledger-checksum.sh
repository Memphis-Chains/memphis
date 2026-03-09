#!/usr/bin/env bash
set -euo pipefail

./scripts/smoke-phase8-closure-ledger.sh >/tmp/mv4-phase8-ledger-checksum.out
./scripts/validate-phase8-closure-ledger-checksum.sh

echo "[smoke-phase8-closure-ledger-checksum] PASS"
