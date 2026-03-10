#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="/tmp/mv4-phase6-proof"
mkdir -p "$OUT_DIR"
PORT=48001
rm -f data/mcp-serve-state.json

env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp serve --port "$PORT" --duration-ms 0 --json >/tmp/mv4-mcp-proof-artifact-serve.out 2>&1 &
PID=$!
sleep 0.8

node - <<'NODE' "$OUT_DIR/transport-proof.json"
const fs = require('fs');
const net = require('net');
const out = process.argv[2];
const state = JSON.parse(fs.readFileSync('data/mcp-serve-state.json','utf8'));

function exchange(req){
  return new Promise((resolve,reject)=>{
    const client = net.createConnection({host:state.host, port:state.port}, ()=>{
      client.write(JSON.stringify(req));
      client.end();
    });
    let data='';
    client.on('data', c=> data += c.toString('utf8'));
    client.on('end', ()=> resolve(data));
    client.on('error', reject);
  });
}

(async()=>{
  const okResRaw = await exchange({ jsonrpc:'2.0', id:'proof-ok', method:'memphis.ask', instanceId:state.instanceId, proof:state.proofToken, params:{ input:'proof artifact', provider:'local-fallback' } });
  const badProofRaw = await exchange({ jsonrpc:'2.0', id:'proof-bad', method:'memphis.ask', instanceId:state.instanceId, proof:'invalid-proof-token', params:{ input:'proof artifact', provider:'local-fallback' } });
  const badInstRaw = await exchange({ jsonrpc:'2.0', id:'inst-bad', method:'memphis.ask', instanceId:'wrong-instance', proof:state.proofToken, params:{ input:'proof artifact', provider:'local-fallback' } });

  const okRes = JSON.parse(okResRaw || '{}');
  const badProof = JSON.parse(badProofRaw || '{}');
  const badInst = JSON.parse(badInstRaw || '{}');

  const artifact = {
    ok: Boolean(okRes.result && okRes.result.output),
    instanceBinding: {
      instanceId: state.instanceId,
      acceptedWithCorrectProof: badProof?.error?.code !== -32002,
      rejectedWrongProof: badProof?.error?.code === -32002,
      rejectedWrongInstance: badInst?.error?.code === -32003,
    },
    checks: {
      okResult: !!okRes.result,
      invalidProofCode: badProof?.error?.code ?? null,
      invalidInstanceCode: badInst?.error?.code ?? null,
    },
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
})();
NODE

npm run -s cli -- mcp serve-stop --json >/tmp/mv4-mcp-proof-artifact-stop.out
wait "$PID" || true

grep -q '"ok": true' "$OUT_DIR/transport-proof.json"
grep -q '"rejectedWrongProof": true' "$OUT_DIR/transport-proof.json"
grep -q '"rejectedWrongInstance": true' "$OUT_DIR/transport-proof.json"

echo "[smoke-phase6-native-mcp-proof-artifact] PASS"
