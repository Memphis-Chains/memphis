#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-native-transport"
mkdir -p "$OUT_DIR"

node - <<'NODE'
const fs=require('fs');
const net=require('net');
const crypto=require('crypto');

const out='/tmp/mv4-phase8-native-transport/transport-proof.json';
const payload=JSON.stringify({kind:'phase8-native-transport', ts:new Date().toISOString()});
const payloadHash=crypto.createHash('sha256').update(payload).digest('hex');

const server = net.createServer((socket)=>{
  socket.on('data',(d)=> socket.write(d));
});
server.listen(0,'127.0.0.1',()=>{
  const port=server.address().port;
  const client = net.createConnection({port, host:'127.0.0.1'}, ()=> client.write(payload));
  client.on('data',(buf)=>{
    const echoed=buf.toString();
    const echoedHash=crypto.createHash('sha256').update(echoed).digest('hex');
    const ok = echoedHash===payloadHash;
    fs.writeFileSync(out, JSON.stringify({ok,payloadHash,echoedHash}, null, 2));
    client.end();
    server.close(()=> process.exit(ok?0:1));
  });
});
NODE

grep -q '"ok": true' "$OUT_DIR/transport-proof.json"
echo "[smoke-phase8-native-transport] PASS"
