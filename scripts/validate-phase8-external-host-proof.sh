#!/usr/bin/env bash
set -euo pipefail

PROOF_PATH="${1:-/tmp/mv4-phase8-external-host-proof.json}"

if [ ! -f "$PROOF_PATH" ]; then
  echo "[validate-phase8-external-host-proof] missing proof: $PROOF_PATH" >&2
  exit 2
fi

node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
if(j.kind!=="phase8-external-host-transport-proof") throw new Error("invalid kind");
if(j.ok!==true) throw new Error("proof not ok");
if(typeof j.payloadHash!=="string"||j.payloadHash.length!==64) throw new Error("invalid payloadHash");
if(typeof j.nodeAHost!=="string"||j.nodeAHost.length<3) throw new Error("invalid nodeAHost");
if(typeof j.nodeBHost!=="string"||j.nodeBHost.length<3) throw new Error("invalid nodeBHost");
if(j.nodeAHost===j.nodeBHost) throw new Error("node hosts must differ for external-host evidence");
if(j.nodeAHost==="127.0.0.1"||j.nodeAHost==="localhost") throw new Error("nodeAHost must not be localhost");
if(j.nodeBHost==="127.0.0.1"||j.nodeBHost==="localhost") throw new Error("nodeBHost must not be localhost");
if(typeof j.nodeAHash!=="string"||j.nodeAHash.length!==64) throw new Error("invalid nodeAHash");
if(typeof j.nodeBHash!=="string"||j.nodeBHash.length!==64) throw new Error("invalid nodeBHash");
if(j.nodeAHash!==j.payloadHash||j.nodeBHash!==j.payloadHash) throw new Error("hash mismatch");
if(typeof j.timestamp!=="string"||j.timestamp.length<10) throw new Error("invalid timestamp");
' "$PROOF_PATH"

echo "[validate-phase8-external-host-proof] PASS"
