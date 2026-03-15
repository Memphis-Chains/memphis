#!/usr/bin/env bash
set -euo pipefail

OUT="$(npm run -s ops:drill-guards -- --json)"
printf '%s\n' "$OUT"

jq -e '.schemaVersion == 1' <<<"$OUT" >/dev/null
jq -e '.ok == true' <<<"$OUT" >/dev/null
jq -e '.scenarios | map(.name) | index("trust-root-invalid-strict") != null' <<<"$OUT" >/dev/null
jq -e '.scenarios | map(.name) | index("revocation-stale") != null' <<<"$OUT" >/dev/null
