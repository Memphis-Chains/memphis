#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/smoke-phase8-signed-chain.sh
./scripts/validate-phase8-signed-proof.sh
./scripts/smoke-phase8-two-node-sync.sh
./scripts/validate-phase8-sync-proof.sh

echo "[smoke-phase8-sovereignty-hard] PASS"
