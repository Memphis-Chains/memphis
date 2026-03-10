#!/usr/bin/env bash
set -euo pipefail

# positive: two distinct non-localhost hosts => ready=true
POSITIVE_JSON="$(npm run -s ops:phase8-external-proof-readiness -- node-a.prod.example node-b.prod.example)"
echo "$POSITIVE_JSON" | node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(0,"utf8"));
if(j.ready!==true) throw new Error("expected ready=true");
if(!Array.isArray(j.reasons) || j.reasons.length!==0) throw new Error("expected no reasons");
'

# negative: localhost + same host => ready=false with reasons
NEGATIVE_JSON="$(npm run -s ops:phase8-external-proof-readiness -- localhost localhost)"
echo "$NEGATIVE_JSON" | node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(0,"utf8"));
if(j.ready!==false) throw new Error("expected ready=false");
if(!j.reasons.includes("hosts-must-differ")) throw new Error("missing hosts-must-differ");
if(!j.reasons.includes("node-a-must-not-be-localhost")) throw new Error("missing node-a localhost reason");
if(!j.reasons.includes("node-b-must-not-be-localhost")) throw new Error("missing node-b localhost reason");
'

echo "[smoke-phase8-external-proof-readiness] PASS"
