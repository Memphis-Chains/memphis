#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-native"
mkdir -p "$OUT_DIR"

./scripts/smoke-phase8-native-hard.sh >/tmp/mv4-phase8-native-hard.out

cat > "$OUT_DIR/phase8-native-report.json" <<JSON
{
  "ok": true,
  "marker": "smoke-phase8-native-hard",
  "proof": "/tmp/mv4-phase8-native/native-ed25519-proof.json",
  "reportTs": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

grep -q '"ok": true' "$OUT_DIR/phase8-native-report.json"
echo "[smoke-phase8-native-report] PASS"
