#!/usr/bin/env bash
set -euo pipefail

PROOF_PATH="${1:-/tmp/mv4-phase8-native-transport-multinode/transport-multinode-proof.json}"

if [ ! -f "$PROOF_PATH" ]; then
  echo "[validate-phase8-native-transport-multinode] missing proof: $PROOF_PATH" >&2
  exit 2
fi

node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
if(j.ok!==true) throw new Error("proof not ok");
if(j.topology!=="nodeA->nodeB relay") throw new Error("unexpected topology");
if(typeof j.payloadHash!=="string"||j.payloadHash.length!==64) throw new Error("invalid payloadHash");
if(!j.nodeA||!j.nodeB) throw new Error("node metadata missing");
if(j.nodeA.hash!==j.payloadHash) throw new Error("nodeA hash mismatch");
if(j.nodeB.hash!==j.payloadHash) throw new Error("nodeB hash mismatch");
if(j.nodeA.received<1||j.nodeB.received<1) throw new Error("node receive counts invalid");
' "$PROOF_PATH"

echo "[validate-phase8-native-transport-multinode] PASS"
