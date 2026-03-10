#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-external-pack-smoke"
REPORT_PATH="$OUT_DIR/phase8-external-host-report.json"
TAMPERED_REPORT_PATH="$OUT_DIR/phase8-external-host-report.tampered.json"

npm run -s ops:phase8-external-proof-pack -- "$OUT_DIR" node-a.prod.example node-b.prod.example >/tmp/mv4-phase8-external-pack-smoke.out
./scripts/validate-phase8-external-proof-pack-report.sh "$REPORT_PATH" >/tmp/mv4-phase8-external-pack-report-validate.out

# negative: tampered report must fail validator
node - "$REPORT_PATH" "$TAMPERED_REPORT_PATH" <<'NODE'
const fs = require('fs');
const src = process.argv[2];
const dst = process.argv[3];
const j = JSON.parse(fs.readFileSync(src, 'utf8'));
j.payloadHash = 'bad';
fs.writeFileSync(dst, JSON.stringify(j, null, 2));
NODE

if ./scripts/validate-phase8-external-proof-pack-report.sh "$TAMPERED_REPORT_PATH" >/tmp/mv4-phase8-external-pack-report-validate-negative.out 2>&1; then
  echo "[smoke-phase8-external-proof-pack] expected validator failure for tampered report" >&2
  exit 1
fi

echo "[smoke-phase8-external-proof-pack] PASS"
