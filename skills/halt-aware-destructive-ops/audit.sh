#!/usr/bin/env bash
# halt-aware-destructive-ops/audit.sh
# Read halt audit JSONL and display recent activity.
#
# Usage:
#   ./audit.sh [last-N]   (default N=10)
#
# Reads:
#   ~/.memphis/audit/halt/events.jsonl (JSONL, one JSON object per line)
#
# Audit storage moved out of chains/ on 2026-09-22 (postmortem
# docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md, action A1).

set -euo pipefail

AUDIT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/audit/halt"
AUDIT_FILE="$AUDIT_DIR/events.jsonl"
last_n="${1:-10}"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq not installed" >&2
    exit 127
fi

if [ ! -f "$AUDIT_FILE" ]; then
    echo "No audit log yet. Run check.sh or verify.sh to populate."
    exit 0
fi

echo "halt audit log (last $last_n entries):"
tail -n "$last_n" "$AUDIT_FILE" | jq -C '{
    index: .index,
    timestamp: .timestamp,
    kind: .kind,
    action: .action,
    args: .args,
    matches: .matches,
    violations: .violations
}' 2>&1 || echo "(jq parse failed on one or more lines)"
