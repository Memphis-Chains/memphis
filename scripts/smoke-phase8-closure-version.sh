#!/usr/bin/env bash
set -euo pipefail

./scripts/smoke-phase8-closure-artifact.sh >/tmp/mv4-phase8-closure-version.out
./scripts/validate-phase8-closure-checksum.sh

grep -q '"schemaVersion": 2' /tmp/mv4-phase8-closure/phase8-closure-artifact.json

echo "[smoke-phase8-closure-version] PASS"
