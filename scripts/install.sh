#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[install] memphis-v4 bootstrap starting"

if ! command -v node >/dev/null 2>&1; then
  echo "[install][fail] node is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[install][fail] npm is required" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"
  fi
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "[install][fail] cargo is required (Rust toolchain)" >&2
  exit 1
fi

npm install

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "[install] created .env from .env.example"
else
  echo "[install] .env already exists, not overwriting"
fi

npm run -s build

echo "[install] running doctor baseline"
DOCTOR_JSON="$(npx tsx src/infra/cli/index.ts doctor --json)"
echo "$DOCTOR_JSON"

DOCTOR_OK="$(printf '%s' "$DOCTOR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j.ok));});")"
if [[ "$DOCTOR_OK" != "true" ]]; then
  echo "[install][fail] doctor baseline failed" >&2
  exit 1
fi

echo "[install][ok] bootstrap complete"
