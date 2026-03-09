#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT1="$(env DEFAULT_PROVIDER=shared-llm SHARED_LLM_API_BASE=https://api.openai.com/v1 SHARED_LLM_API_KEY=smoke npm run -s cli -- decide --input "Decyduję: provider - ollama" --json)"
OUT2="$(env DEFAULT_PROVIDER=shared-llm SHARED_LLM_API_BASE=https://api.openai.com/v1 SHARED_LLM_API_KEY=smoke npm run -s cli -- infer --input "Wybieram: model - qwen" --json)"

echo "$OUT1" | grep -q '"ok": true'
echo "$OUT1" | grep -q '"detected": true'
echo "$OUT2" | grep -q '"ok": true'
echo "$OUT2" | grep -q '"detected": true'

echo "[smoke-phase5-decision] PASS"
