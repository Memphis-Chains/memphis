#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_FILE="${TMPDIR:-/tmp}/memphis-v4-smoke-tui.out"
rm -f "$OUT_FILE"

printf '/help\n/health\n/exit\n' | env \
  DEFAULT_PROVIDER=shared-llm \
  SHARED_LLM_API_BASE=https://api.openai.com/v1 \
  SHARED_LLM_API_KEY=smoke \
  timeout 20s npm run -s cli -- tui >"$OUT_FILE" 2>&1 || {
  echo "[smoke-tui] failed"
  cat "$OUT_FILE"
  exit 1
}

grep -q "Memphis TUI" "$OUT_FILE"
grep -q "screen=" "$OUT_FILE"

echo "[smoke-tui] PASS"
