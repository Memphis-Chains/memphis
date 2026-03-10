#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=47999
rm -f data/mcp-serve-state.json

env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp serve --port "$PORT" --duration-ms 0 --json >/tmp/mv4-mcp-instance-negative-serve.out 2>&1 &
PID=$!
sleep 0.8

node - <<'NODE' > /tmp/mv4-mcp-instance-negative.out
const fs = require('fs');
const net = require('net');
const state = JSON.parse(fs.readFileSync('data/mcp-serve-state.json','utf8'));
const req = { jsonrpc:'2.0', id:'bad-instance-1', method:'memphis.ask', instanceId:'wrong-instance-id', proof:state.proofToken, params:{ input:'hello', provider:'local-fallback' } };
const client = net.createConnection({ host: state.host, port: state.port }, () => {
  client.write(JSON.stringify(req));
  client.end();
});
let data='';
client.on('data', chunk => { data += chunk.toString('utf8'); });
client.on('end', () => { process.stdout.write(data); });
client.on('error', err => { console.error(err); process.exit(1); });
NODE

grep -q '"code":-32003' /tmp/mv4-mcp-instance-negative.out
grep -q 'invalid_instance' /tmp/mv4-mcp-instance-negative.out

npm run -s cli -- mcp serve-stop --json >/tmp/mv4-mcp-instance-negative-stop.out
wait "$PID" || true

echo "[smoke-phase6-native-mcp-instance-negative] PASS"
