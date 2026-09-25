#!/usr/bin/env bash
# halt-aware-destructive-ops/check.sh
# Check whether any argument matches a halted resource.
# Exit 0 = safe to proceed. Exit 1 = blocked. Exit 2 = bypass required.
#
# Usage:
#   ./check.sh <path> [path...]
#   HALT_BYPASS=1 ./check.sh <path>
#   HALT_BYPASS_REASON="reason" ./check.sh <path>
#
# Reads:
#   ~/.memphis/halt/*.json
# Appends:
#   ~/.memphis/audit/halt/events.jsonl (one JSON object per line)
#
# Audit storage moved out of chains/ on 2026-09-22 (postmortem
# docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md, action A1).
# Writing under chains/ would create non-conforming chain blocks (no
# prev_hash/hash) and crash memphis at next BOOT. JSONL append-only is
# the correct shape for an audit log.

set -euo pipefail

HALT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/halt"
AUDIT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/audit/halt"
AUDIT_FILE="$AUDIT_DIR/events.jsonl"

if [ $# -eq 0 ]; then
    echo "Usage: $0 <path> [path...]" >&2
    exit 64
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq not installed (apt install jq)" >&2
    exit 127
fi

mkdir -p "$AUDIT_DIR"

# Monotonic event index, computed from existing JSONL line count.
# Atomic-ish via wc -l; for concurrent writes use flock in caller.
new_index=$(wc -l < "$AUDIT_FILE" 2>/dev/null || echo 0)
new_index=$((new_index + 1))

# Iterate HALT list
result="pass"
matches=()
if [ -d "$HALT_DIR" ]; then
    for halt_file in "$HALT_DIR"/*.json; do
        [ -e "$halt_file" ] || continue
        halted_resource=$(jq -r '.resourcePath // empty' "$halt_file" 2>/dev/null || true)
        [ -z "$halted_resource" ] && continue
        halted_by=$(jq -r '.haltedBy // "unknown"' "$halt_file" 2>/dev/null || true)
        reason=$(jq -r '.reason // "no reason given"' "$halt_file" 2>/dev/null || true)

        for arg in "$@"; do
            arg_base=$(basename "$arg")
            halt_base=$(basename "$halted_resource")
            if [ "$arg" = "$halted_resource" ] || [ "$arg_base" = "$halt_base" ]; then
                matches+=("$halted_resource|$halted_by|$reason")
                result="block"
            fi
        done
    done
fi

# Handle bypass
if [ "$result" = "block" ] && [ "${HALT_BYPASS:-0}" != "1" ]; then
    echo "HALT GUARD BLOCKED" >&2
    echo "  Matched halted resource(s):" >&2
    for m in "${matches[@]}"; do
        IFS='|' read -r res by reason <<< "$m"
        echo "    - $res" >&2
        echo "      halted-by: $by" >&2
        echo "      reason:    $reason" >&2
    done
    echo "  To proceed consciously, set HALT_BYPASS=1 + HALT_BYPASS_REASON='...'" >&2
    audit_action="block"
    audit_result=1
elif [ "$result" = "block" ]; then
    echo "HALT GUARD BYPASSED with HALT_BYPASS_REASON='${HALT_BYPASS_REASON:-unset}'" >&2
    echo "  Matched: ${matches[*]}" >&2
    audit_action="bypass"
    audit_result=0
else
    audit_action="pass"
    audit_result=0
fi

# Build audit line safely (jq -c for compact one-line JSON)
args_json=$(printf '%s\n' "$@" | jq -R . | jq -s 'map(select(length > 0))')
matches_json=$(printf '%s\n' "${matches[@]:-}" | jq -R . | jq -s 'map(select(length > 0))')

jq -nc \
    --argjson index "$new_index" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action "$audit_action" \
    --argjson args "$args_json" \
    --argjson matches "$matches_json" \
    --arg bypass_reason "${HALT_BYPASS_REASON:-}" \
    --arg caller "${USER:-unknown}@$(hostname 2>/dev/null || echo unknown)" \
    '{
        kind: "halt-check",
        index: $index,
        timestamp: $timestamp,
        action: $action,
        args: $args,
        matches: $matches,
        bypass_reason: $bypass_reason,
        caller: $caller
    }' >> "$AUDIT_FILE"

exit $audit_result
