#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

cp .env.example "$TMP_DIR/.env"
DOCTOR_JSON="$(env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development npm_config_loglevel=silent \
  bash -lc "cd '$ROOT_DIR' && cp '$TMP_DIR/.env' .env && npx tsx src/infra/cli/index.ts doctor --json")"

echo "$DOCTOR_JSON"
printf '%s' "$DOCTOR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!j.ok)process.exit(1);});"

echo "[smoke][ok] fresh doctor baseline passed"
