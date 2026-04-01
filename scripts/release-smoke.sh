#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

npm run -s lint
npm run -s typecheck
npm run -s test:rust
npx vitest run \
  tests/unit/rust-tui-launcher.test.ts \
  tests/unit/cli.completion.test.ts \
  tests/unit/first-run-plan.test.ts \
  tests/unit/cli.init-status.test.ts \
  tests/ops/rc-release-truth-contract.test.ts
npm run -s ops:ga-smoke
bash ./scripts/install.sh --check-only --json >/dev/null
npm run -s ops:rc-drill:fresh-env
./scripts/secret-scan.sh
echo "release-smoke: PASS"
