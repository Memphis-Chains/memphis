#!/usr/bin/env bash
set -euo pipefail

PROOF_PATH="${1:-/tmp/mv4-phase8/signed-proof.json}"

if [ ! -f "$PROOF_PATH" ]; then
  echo "[validate-phase8-signed] missing proof: $PROOF_PATH" >&2
  exit 2
fi

node -e '
const fs=require("fs");
const crypto=require("crypto");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
if(typeof j.blockPath!=="string"||!j.blockPath) throw new Error("missing blockPath");
if(typeof j.checksum!=="string"||j.checksum.length!==64) throw new Error("invalid checksum");
if(typeof j.signature!=="string"||j.signature.length!==64) throw new Error("invalid signature");
if(j.verified!==true) throw new Error("verified flag false");
const block = fs.readFileSync(j.blockPath);
const checksum = crypto.createHash("sha256").update(block).digest("hex");
if(checksum!==j.checksum) throw new Error("checksum mismatch");
const sig = crypto.createHash("sha256").update(j.checksum).digest("hex");
if(sig!==j.signature) throw new Error("signature mismatch");
' "$PROOF_PATH"

echo "[validate-phase8-signed] PASS"
