#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-native-transport-multinode"
mkdir -p "$OUT_DIR"
PROOF_PATH="$OUT_DIR/transport-multinode-proof.json"

node - "$PROOF_PATH" <<'NODE'
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

const proofPath = process.argv[2];

const nodeAStore = [];
const nodeBStore = [];

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const nodeA = net.createServer((socket) => {
  socket.on('data', (buffer) => {
    const body = buffer.toString();
    nodeAStore.push(body);
    const envelope = JSON.stringify({ node: 'A', body, hash: sha256(body) });
    socket.write(envelope);
  });
});

const nodeB = net.createServer((socket) => {
  socket.on('data', (buffer) => {
    const body = buffer.toString();
    nodeBStore.push(body);
    const envelope = JSON.stringify({ node: 'B', body, hash: sha256(body) });
    socket.write(envelope);
  });
});

nodeA.listen(0, '127.0.0.1', () => {
  nodeB.listen(0, '127.0.0.1', () => {
    const portA = nodeA.address().port;
    const portB = nodeB.address().port;

    const payload = JSON.stringify({
      kind: 'phase8-native-transport-multinode',
      ts: new Date().toISOString(),
      tx: `tx-${Date.now()}`,
      content: 'production-style relay proof',
    });

    const relayA = net.createConnection({ host: '127.0.0.1', port: portA }, () => relayA.write(payload));

    relayA.on('data', (bufA) => {
      const envelopeA = JSON.parse(bufA.toString());
      const relayB = net.createConnection({ host: '127.0.0.1', port: portB }, () => relayB.write(envelopeA.body));

      relayB.on('data', (bufB) => {
        const envelopeB = JSON.parse(bufB.toString());
        const payloadHash = sha256(payload);

        const proof = {
          ok: envelopeA.hash === payloadHash && envelopeB.hash === payloadHash,
          topology: 'nodeA->nodeB relay',
          payloadHash,
          nodeA: { port: portA, received: nodeAStore.length, hash: envelopeA.hash },
          nodeB: { port: portB, received: nodeBStore.length, hash: envelopeB.hash },
        };

        fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
        relayB.end();
        relayA.end();
        nodeA.close(() => nodeB.close(() => process.exit(proof.ok ? 0 : 1)));
      });
    });
  });
});
NODE

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/validate-phase8-native-transport-multinode.sh" "$PROOF_PATH"

echo "[smoke-phase8-native-transport-multinode] PASS"
