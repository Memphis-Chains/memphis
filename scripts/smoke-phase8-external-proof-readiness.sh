#!/usr/bin/env bash
set -euo pipefail

# positive: two distinct non-localhost hosts => READY
POSITIVE_JSON="$(npm run -s ops:phase8-external-proof-readiness -- node-a.prod.example node-b.prod.example)"
echo "$POSITIVE_JSON" | node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(0,"utf8"));
if(j.ready!==true) throw new Error("expected ready=true");
if(j.status!=="READY") throw new Error("expected status=READY");
if(j.blockerCode!=="NONE") throw new Error("expected blockerCode=NONE");
if(!Array.isArray(j.reasons) || j.reasons.length!==0) throw new Error("expected no reasons");
if(!Array.isArray(j.blockerCodes) || j.blockerCodes.length!==0) throw new Error("expected no blocker codes");
'

# negative A: both hosts localhost => BLOCKED with multiple blocker codes
NEG_LOCAL_JSON="$(npm run -s ops:phase8-external-proof-readiness -- localhost localhost)"
echo "$NEG_LOCAL_JSON" | node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(0,"utf8"));
if(j.ready!==false) throw new Error("expected ready=false");
if(j.status!=="BLOCKED") throw new Error("expected status=BLOCKED");
if(j.blockerCode!=="HOSTS_MUST_DIFFER") throw new Error("expected primary blocker HOSTS_MUST_DIFFER");
for (const code of ["HOSTS_MUST_DIFFER","NODE_A_LOCALHOST_FORBIDDEN","NODE_B_LOCALHOST_FORBIDDEN"]) {
  if(!j.blockerCodes.includes(code)) throw new Error(`missing blocker code ${code}`);
}
'

# negative B: missing node A => BLOCKED + MISSING_NODE_A_HOST
NEG_MISSING_A_JSON="$(npm run -s ops:phase8-external-proof-readiness -- "" node-b.prod.example)"
echo "$NEG_MISSING_A_JSON" | node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(0,"utf8"));
if(j.status!=="BLOCKED") throw new Error("expected status=BLOCKED");
if(j.blockerCode!=="MISSING_NODE_A_HOST") throw new Error("expected blocker MISSING_NODE_A_HOST");
if(!j.blockerCodes.includes("MISSING_NODE_A_HOST")) throw new Error("missing blocker code MISSING_NODE_A_HOST");
'

echo "[smoke-phase8-external-proof-readiness] PASS"
