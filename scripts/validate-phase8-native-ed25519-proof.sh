#!/usr/bin/env bash
set -euo pipefail

PROOF_PATH="${1:-/tmp/mv4-phase8-native/native-ed25519-proof.json}"

if [ ! -f "$PROOF_PATH" ]; then
  echo "[validate-phase8-native-ed25519] missing proof: $PROOF_PATH" >&2
  exit 2
fi

node -e '
const fs=require("fs");
const crypto=require("crypto");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(j.ok!==true) throw new Error("ok flag false");
if(typeof j.payload!=="string" || !j.payload.length) throw new Error("missing payload");
if(typeof j.signature!=="string" || !j.signature.length) throw new Error("missing signature");
const payload = JSON.parse(j.payload);
if(!payload.chain || typeof payload.index !== "number") throw new Error("invalid payload schema");
' "$PROOF_PATH"

echo "[validate-phase8-native-ed25519] PASS"
