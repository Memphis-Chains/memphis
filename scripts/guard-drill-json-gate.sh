#!/usr/bin/env bash
set -euo pipefail

# Raw output can be contaminated with node deprecation warnings like
# `(node:1234) [DEP0040] DeprecationWarning: ...` that land on stdout
# in non-TTY CI environments. Extract the JSON blob by sed-stripping
# everything before the first line that starts with `{`.
RAW="$(npm run -s ops:drill-guards -- --json)"
printf '%s\n' "$RAW"

OUT="$(printf '%s\n' "$RAW" | sed -n '/^{/,$p')"

jq -e '.schemaVersion == 1' <<<"$OUT" >/dev/null
jq -e '.ok == true' <<<"$OUT" >/dev/null
jq -e '.scenarios | map(.name) | index("trust-root-invalid-strict") != null' <<<"$OUT" >/dev/null
jq -e '.scenarios | map(.name) | index("revocation-stale") != null' <<<"$OUT" >/dev/null
