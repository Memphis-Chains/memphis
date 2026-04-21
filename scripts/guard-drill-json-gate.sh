#!/usr/bin/env bash
set -euo pipefail

# Node can emit deprecation warnings like `(node:1234) [DEP0040]
# DeprecationWarning: …` to stdout in non-TTY CI environments, which
# would otherwise contaminate the JSON output expected by both the
# `jq` gates below and downstream consumers (tests/CI pipelines that
# parse the whole stdout). Strip everything before the first `{` line
# so both the script's output and internal parsing see clean JSON.
RAW="$(npm run -s ops:drill-guards -- --json)"
OUT="$(printf '%s\n' "$RAW" | sed -n '/^{/,$p')"

printf '%s\n' "$OUT"

jq -e '.schemaVersion == 1' <<<"$OUT" >/dev/null
jq -e '.ok == true' <<<"$OUT" >/dev/null
jq -e '.scenarios | map(.name) | index("trust-root-invalid-strict") != null' <<<"$OUT" >/dev/null
jq -e '.scenarios | map(.name) | index("revocation-stale") != null' <<<"$OUT" >/dev/null
