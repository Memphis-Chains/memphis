#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/smoke-phase8-native-ed25519.sh
./scripts/validate-phase8-native-ed25519-proof.sh
./scripts/smoke-phase8-sovereignty-hard.sh

echo "[smoke-phase8-native-hard] PASS"
