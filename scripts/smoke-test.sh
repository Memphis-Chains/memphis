#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Compatibility entrypoint expected by blueprint/spec.
# Mapped to deterministic local smoke stack (no external runtime dependency).
set +e
DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts doctor --json >/tmp/mv4-smoke-doctor.json
DOCTOR_EXIT=$?
set -e

if [[ "$DOCTOR_EXIT" -ne 0 && "$DOCTOR_EXIT" -ne 1 ]]; then
  echo "doctor command failed unexpectedly with exit=$DOCTOR_EXIT"
  exit 1
fi

node -e "const fs=require('node:fs'); const data=JSON.parse(fs.readFileSync('/tmp/mv4-smoke-doctor.json','utf8')); if(!Array.isArray(data.checks)){process.exit(1)}"
DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts health --json >/tmp/mv4-smoke-health.json
DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts ask --input "smoke" --json >/tmp/mv4-smoke-ask.json

echo "SMOKE_TEST_OK"
