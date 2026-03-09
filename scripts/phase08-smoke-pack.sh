#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[phase08] lint"
npm run -s lint

echo "[phase08] typecheck"
npm run -s typecheck

echo "[phase08] tests"
npm run -s test

echo "[phase08] build"
npm run -s build

echo "[phase08] retrieval gate"
npm run -s bench:retrieval:gate

echo "[phase08] onboarding bootstrap dry-run"
npm run -s cli -- onboarding bootstrap --profile dev-local --dry-run --json >/tmp/mv4-phase08-bootstrap-dry.json

echo "[phase08] PASS"
