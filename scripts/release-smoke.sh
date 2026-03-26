#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

npm run -s lint
npm run -s typecheck
npm run -s ops:ga-smoke
bash ./scripts/install.sh --check-only --json >/dev/null
npm run -s ops:source-bootstrap-smoke
npm run -s ops:validate-package-artifact
./scripts/secret-scan.sh
echo "release-smoke: PASS"
