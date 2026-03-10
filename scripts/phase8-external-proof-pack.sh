#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-/tmp/mv4-phase8-external-pack}"
NODE_A_HOST="${2:-node-a.prod.example}"
NODE_B_HOST="${3:-node-b.prod.example}"

mkdir -p "$OUT_DIR"
PROOF_PATH="$OUT_DIR/phase8-external-host-proof.json"
LEDGER_PATH="data/phase8-closure-ledger.jsonl"
REPORT_PATH="$OUT_DIR/phase8-external-host-report.json"

./scripts/phase8-external-host-proof-template.sh "$PROOF_PATH" "$NODE_A_HOST" "$NODE_B_HOST" >/tmp/mv4-phase8-external-pack-template.out
./scripts/validate-phase8-external-host-proof.sh "$PROOF_PATH" >/tmp/mv4-phase8-external-pack-validate.out
./scripts/phase8-external-proof-ledger-append.sh "$PROOF_PATH" "$LEDGER_PATH" >/tmp/mv4-phase8-external-pack-ledger.out

node - "$PROOF_PATH" "$LEDGER_PATH" "$REPORT_PATH" <<'NODE'
const fs = require('fs');
const proofPath = process.argv[2];
const ledgerPath = process.argv[3];
const reportPath = process.argv[4];

const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
const latest = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;

const report = {
  ok: true,
  kind: 'phase8-external-host-pack-report',
  proofPath,
  ledgerPath,
  latestLedgerEntry: latest,
  nodeAHost: proof.nodeAHost,
  nodeBHost: proof.nodeBHost,
  payloadHash: proof.payloadHash,
  reportTs: new Date().toISOString(),
};

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
NODE

grep -q '"ok": true' "$REPORT_PATH"
echo "[phase8-external-proof-pack] PASS"
