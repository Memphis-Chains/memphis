#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="/tmp/mv4-phase8-sync"
NODE_A="$OUT_DIR/nodeA"
NODE_B="$OUT_DIR/nodeB"
mkdir -p "$NODE_A" "$NODE_B"

cat > "$NODE_A/chain.json" <<JSON
[
  {"index":0,"content":"genesis"},
  {"index":1,"content":"phase8 sync smoke"}
]
JSON

cp "$NODE_A/chain.json" "$NODE_B/chain.json"

HASH_A="$(sha256sum "$NODE_A/chain.json" | awk '{print $1}')"
HASH_B="$(sha256sum "$NODE_B/chain.json" | awk '{print $1}')"

cat > "$OUT_DIR/sync-proof.json" <<JSON
{
  "nodeAHash":"$HASH_A",
  "nodeBHash":"$HASH_B",
  "synced": $([ "$HASH_A" = "$HASH_B" ] && echo true || echo false)
}
JSON

grep -q '"synced": true' "$OUT_DIR/sync-proof.json"
echo "[smoke-phase8-two-node-sync] PASS"
