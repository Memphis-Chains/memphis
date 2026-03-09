#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail=0
for f in \
  scripts/phase08-smoke-pack.sh \
  scripts/phase08-smoke-pack-report.sh \
  scripts/phase08-clean-runtime-artifacts.sh

do
  if [ ! -x "$f" ]; then
    echo "[verify] missing or not executable: $f"
    fail=1
  fi
done

for cmd in ops:phase08-smoke-pack ops:phase08-smoke-pack:report ops:phase08-clean
do
  if ! node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts['$cmd'] ? 0 : 1)"; then
    echo "[verify] missing npm script: $cmd"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "[verify] FAIL"
  exit 1
fi

echo "[verify] PASS"
