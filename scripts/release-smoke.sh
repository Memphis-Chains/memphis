#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

# Build the Rust NAPI bridge in release mode so the downstream tests
# (cli.completion / cli.init-status / first-run-plan / etc.) can load
# `crates/memphis-paths` via the bridge. Without this, the release
# workflow only has what `npm ci` produced — no Rust build at all,
# because `prepack` runs before `npm pack`, not before release-smoke.
# v1.9.1 / v1.9.2 / v1.10.0 release workflows all failed with
# `paths bridge unavailable` before this line landed.
# Skip via SKIP_RUST_BUILD=1 when iterating locally with a fresh
# bridge already on disk.
if [[ "${SKIP_RUST_BUILD:-}" != "1" ]]; then
  npm run -s build:rust:release
fi

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
