#!/usr/bin/env bash
set -euo pipefail

PROOF_PATH="${1:-/tmp/mv4-phase8-sync/sync-proof.json}"

if [ ! -f "$PROOF_PATH" ]; then
  echo "[validate-phase8-sync] missing proof: $PROOF_PATH" >&2
  exit 2
fi

node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
if(typeof j.nodeAHash!=="string"||j.nodeAHash.length!==64) throw new Error("invalid nodeAHash");
if(typeof j.nodeBHash!=="string"||j.nodeBHash.length!==64) throw new Error("invalid nodeBHash");
if(j.synced!==true) throw new Error("synced flag false");
if(j.nodeAHash!==j.nodeBHash) throw new Error("hash drift detected");
' "$PROOF_PATH"

echo "[validate-phase8-sync] PASS"
