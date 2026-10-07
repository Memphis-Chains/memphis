#!/usr/bin/env bash
set -euo pipefail

# Production dependency audit — the single implementation behind both
# .github/workflows/ci.yml and scripts/nightly-crystal-pass.sh.
#
# WHY THIS IS A SCRIPT AND NOT INLINE YAML
# ---------------------------------------
# The two callers disagreed, which is why nightly-crystal failed every night
# while ci stayed green. ci.yml ran an audited jq filter with a one-advisory
# allowlist and an explicit note about *why* each advisory is allowed; nightly
# ran a bare `npm audit --omit=dev --audit-level=high`, so a single accepted
# high advisory failed the whole job. That job is where pii-scan.sh and
# secret-scan.sh lived — the security gates were inside a permanently red
# check, which is the same class of mistake as a scan whose pattern list does
# not match the value it needs to catch.
#
# Both callers now run this file, so an allowlist entry cannot exist in one
# and not the other.
#
# Contract:
#   critical  -> always fails. There is no allowlist for critical.
#   high      -> fails unless every high advisory is in ADVISORY_ALLOWLIST.
#   moderate  -> reported, never fails.
#
# Usage: bash scripts/dep-audit.sh [--json]
#   --json  emit the raw `npm audit --json` payload to stdout for callers
#           that want to archive it.

set -o pipefail

# --- allowlist --------------------------------------------------------------
# GHSA-q7rr-3cgh-j5r3 — @opentelemetry/exporter-prometheus <0.217.0 (high).
# OTEL is opt-in: disabled by default and never imported on the default
# runtime path (operator decision 2026-05-11). The fix is a semver-major
# bump the operator deliberately declined. Remove this line when OTEL is
# upgraded, not before — and update the nightly caller at the same time,
# which is the whole reason both callers share this file.
ADVISORY_ALLOWLIST="GHSA-q7rr-3cgh-j5r3"

emit_json=false
if [ "${1:-}" = "--json" ]; then
  emit_json=true
fi

audit_json="$(npm audit --omit=dev --json 2>/dev/null || true)"

if [ -z "$audit_json" ]; then
  echo "[dep-audit] npm audit produced no output — treating as failure"
  echo "[dep-audit] A silent audit is indistinguishable from a passing one."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[dep-audit] jq not installed (apt install jq)"
  exit 127
fi

if $emit_json; then
  printf '%s\n' "$audit_json"
fi

critical_count=$(printf '%s' "$audit_json" | jq '.metadata.vulnerabilities.critical // 0')
if [ "$critical_count" -gt 0 ]; then
  echo "::error::$critical_count critical vulnerabilities — fix required"
  printf '%s' "$audit_json" | jq -r '
    .vulnerabilities
    | to_entries[]
    | select(.value.severity == "critical")
    | "\(.key): \(.value.via[]? | if type == "object" then (.url // .title // "?") else . end)"
  ' >&2
  exit 1
fi

unallowed=$(printf '%s' "$audit_json" | jq -r --arg al "$ADVISORY_ALLOWLIST" '
  .vulnerabilities
  | to_entries[]
  | select(.value.severity == "high")
  | .value.via[]?
  | select(type == "object")
  | (.url // "")
' | grep -oE 'GHSA-[a-z0-9-]+' | sort -u | grep -vxF "$ADVISORY_ALLOWLIST" || true)

moderate_count=$(printf '%s' "$audit_json" | jq '.metadata.vulnerabilities.moderate // 0')

if [ -n "$unallowed" ]; then
  echo "::error::Unallowed high advisories detected:"
  printf '%s\n' "$unallowed" | sed 's/^/  /' >&2
  exit 1
fi

echo "[dep-audit] OK — 0 critical, high advisities allowlisted: $ADVISORY_ALLOWLIST, $moderate_count moderate (non-blocking)"