#!/usr/bin/env bash
set -euo pipefail

PORT=47991
REQ='{"jsonrpc":"2.0","id":"serve-smoke-1","method":"memphis.ask","params":{"input":"serve smoke","provider":"local-fallback"}}'

env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp serve --port "$PORT" --duration-ms 3000 --json >/tmp/mv4-mcp-serve.out 2>&1 &
PID=$!

sleep 0.6
RESP="$(node - <<'NODE' "$PORT" "$REQ"
const net=require('net');
const port=Number(process.argv[2]);
const req=process.argv[3];
const client=net.createConnection({host:'127.0.0.1', port}, ()=>client.write(req));
let data='';
client.on('data',(c)=> data += c.toString('utf8'));
client.on('end',()=>{process.stdout.write(data);});
setTimeout(()=>{client.end();},800);
NODE
)"

echo "$RESP" | grep -q '"jsonrpc":"2.0"'
echo "$RESP" | grep -q '"output"'

wait "$PID"

echo "[smoke-phase6-native-mcp-serve] PASS"
