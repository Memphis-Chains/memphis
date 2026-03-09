#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Compatibility entrypoint expected by blueprint/spec.
# Mapped to deterministic local smoke stack (no external runtime dependency).
DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts doctor --json >/tmp/mv4-smoke-doctor.json
DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts health --json >/tmp/mv4-smoke-health.json
DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts ask --input "smoke" --json >/tmp/mv4-smoke-ask.json

echo "SMOKE_TEST_OK"
