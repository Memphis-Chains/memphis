#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase8-native"
mkdir -p "$OUT_DIR"

node - <<'NODE'
const fs = require('fs');
const crypto = require('crypto');

const outDir = '/tmp/mv4-phase8-native';
const payload = JSON.stringify({ chain: 'journal', index: 2, content: 'phase8 native ed25519 smoke' });

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const sig = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
const ok = crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(sig, 'base64'));

if (!ok) {
  console.error('ed25519 verify failed');
  process.exit(1);
}

fs.writeFileSync(`${outDir}/native-ed25519-proof.json`, JSON.stringify({ ok, payload, signature: sig }, null, 2));
NODE

echo "[smoke-phase8-native-ed25519] PASS"
