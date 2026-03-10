#!/usr/bin/env bash
set -euo pipefail

PROOF_PATH="${1:-/tmp/mv4-phase8-external-host-proof.json}"
LEDGER_PATH="${2:-data/phase8-closure-ledger.jsonl}"

./scripts/validate-phase8-external-host-proof.sh "$PROOF_PATH" >/tmp/mv4-phase8-external-proof-ledger-validate.out

mkdir -p "$(dirname "$LEDGER_PATH")"

node - "$PROOF_PATH" "$LEDGER_PATH" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');

const proofPath = process.argv[2];
const ledgerPath = process.argv[3];
const proofRaw = fs.readFileSync(proofPath, 'utf8');
const proof = JSON.parse(proofRaw);

const proofChecksum = crypto.createHash('sha256').update(proofRaw).digest('hex');

const entry = {
  ts: new Date().toISOString(),
  schemaVersion: 1,
  proofType: 'phase8-external-host-transport-proof',
  payloadHash: proof.payloadHash,
  proofChecksum,
  nodeAHost: proof.nodeAHost,
  nodeBHost: proof.nodeBHost,
  sourceProofPath: proofPath,
};

fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
NODE

tail -n 1 "$LEDGER_PATH" | grep -q '"proofType":"phase8-external-host-transport-proof"'

echo "[phase8-external-proof-ledger-append] PASS"
