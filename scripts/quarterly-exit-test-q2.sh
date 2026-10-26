#!/usr/bin/env bash
# Q2 acceptance follows the ship criteria in the Y1 roadmap. Runtime probes
# use an isolated home; they never install checkpoints into the operator home.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT_DIR/scripts/quarterly-exit-test-q2.mjs"
