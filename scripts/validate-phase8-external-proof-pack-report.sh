#!/usr/bin/env bash
set -euo pipefail

REPORT_PATH="${1:-/tmp/mv4-phase8-external-pack/phase8-external-host-report.json}"

if [ ! -f "$REPORT_PATH" ]; then
  echo "[validate-phase8-external-proof-pack-report] missing report: $REPORT_PATH" >&2
  exit 2
fi

node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
if(j.ok!==true) throw new Error("report not ok");
if(j.kind!=="phase8-external-host-pack-report") throw new Error("invalid kind");
if(typeof j.proofPath!=="string"||j.proofPath.length<3) throw new Error("invalid proofPath");
if(typeof j.ledgerPath!=="string"||j.ledgerPath.length<3) throw new Error("invalid ledgerPath");
if(typeof j.nodeAHost!=="string"||j.nodeAHost.length<3) throw new Error("invalid nodeAHost");
if(typeof j.nodeBHost!=="string"||j.nodeBHost.length<3) throw new Error("invalid nodeBHost");
if(j.nodeAHost===j.nodeBHost) throw new Error("hosts must differ");
if(typeof j.payloadHash!=="string"||j.payloadHash.length!==64) throw new Error("invalid payloadHash");
if(!j.latestLedgerEntry||j.latestLedgerEntry.proofType!=="phase8-external-host-transport-proof") {
  throw new Error("missing latest external-proof ledger entry");
}
if(typeof j.reportTs!=="string"||j.reportTs.length<10) throw new Error("invalid reportTs");
' "$REPORT_PATH"

echo "[validate-phase8-external-proof-pack-report] PASS"
