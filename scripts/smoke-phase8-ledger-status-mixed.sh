#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-ledger-status-mixed"
mkdir -p "$OUT_DIR"

npm run -s ops:phase8-external-proof-pack -- "$OUT_DIR" node-a.prod.example node-b.prod.example >/tmp/mv4-phase8-ledger-status-mixed-pack.out
STATUS_JSON="$(npm run -s ops:phase8-ledger-status)"

echo "$STATUS_JSON" | node -e '
const fs=require("fs");
const raw=fs.readFileSync(0,"utf8");
const j=JSON.parse(raw);
if(j.ok!==true) throw new Error("status not ok");
if(!j.latestClosure || !j.latestClosure.closureChecksum) throw new Error("missing latestClosure");
if(!j.latestExternalProof || j.latestExternalProof.proofType!=="phase8-external-host-transport-proof") {
  throw new Error("missing latestExternalProof");
}
if(!j.latestExternalProof.proofChecksum || j.latestExternalProof.proofChecksum.length!==64) {
  throw new Error("invalid external proof checksum");
}
'

echo "[smoke-phase8-ledger-status-mixed] PASS"
