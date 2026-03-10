#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-external-pack-smoke"
REPORT_PATH="$OUT_DIR/phase8-external-host-report.json"

npm run -s ops:phase8-external-proof-pack -- "$OUT_DIR" node-a.prod.example node-b.prod.example >/tmp/mv4-phase8-external-pack-smoke.out

node - "$REPORT_PATH" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
if (j.ok !== true) throw new Error('report not ok');
if (j.kind !== 'phase8-external-host-pack-report') throw new Error('invalid kind');
if (!j.latestLedgerEntry || j.latestLedgerEntry.proofType !== 'phase8-external-host-transport-proof') {
  throw new Error('missing latest external-proof ledger entry');
}
if (!j.payloadHash || j.payloadHash.length !== 64) throw new Error('invalid payloadHash');
NODE

echo "[smoke-phase8-external-proof-pack] PASS"
