#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/phase08-status.sh >/tmp/mv4-phase08-status.out

grep -q "\[phase08-status\] head=" /tmp/mv4-phase08-status.out

echo "[smoke-phase08-status] PASS"
