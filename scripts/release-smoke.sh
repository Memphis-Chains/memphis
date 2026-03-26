#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

npm run -s lint
npm run -s typecheck
npm run -s ops:ga-smoke
npm run -s pack:dry-run
./scripts/secret-scan.sh
echo "release-smoke: PASS"
