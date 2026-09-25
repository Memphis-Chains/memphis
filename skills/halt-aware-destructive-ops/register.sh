#!/usr/bin/env bash
# halt-aware-destructive-ops/register.sh
# Register a resource as HALT.
#
# Usage:
#   ./register.sh <resource-path> <halted-by-chain-ref> <reason> [expires-at] [verify-command]

set -euo pipefail

HALT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/halt"
mkdir -p "$HALT_DIR"

if [ $# -lt 3 ]; then
    echo "Usage: $0 <resource-path> <halted-by-chain-ref> <reason> [expires-at] [verify-command]" >&2
    exit 64
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq not installed (apt install jq)" >&2
    exit 127
fi

resource_path="$1"
halted_by="$2"
reason="$3"
expires_at_raw="${4-}"
verify_cmd="${5-}"

# Use sha256 of resource_path as filename (deterministic, no path conflicts)
filename=$(printf '%s' "$resource_path" | sha256sum | cut -c1-16)
out="$HALT_DIR/$filename.json"

if [ -e "$out" ]; then
    echo "WARNING: HALT entry already exists for $resource_path" >&2
    jq '.' "$out"
    exit 1
fi

# Validate expires_at: must be ISO 8601 timestamp, "null", or empty (treated as null)
if [ -z "$expires_at_raw" ] || [ "$expires_at_raw" = "null" ]; then
    expires_at_json="null"
elif date -d "$expires_at_raw" +%s >/dev/null 2>&1; then
    expires_at_json=$(jq -n --arg s "$expires_at_raw" '$s')
else
    echo "ERROR: invalid expires-at '$expires_at_raw' (expected ISO 8601 timestamp or 'null')" >&2
    exit 65
fi

# Build with jq for safe escaping
jq -n \
    --arg resourcePath "$resource_path" \
    --arg haltedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg haltedBy "$halted_by" \
    --arg reason "$reason" \
    --argjson expiresAt "$expires_at_json" \
    --arg registeredBy "${USER:-unknown}" \
    --arg verifyCommand "$verify_cmd" \
    '{
        resourcePath: $resourcePath,
        haltedAt: $haltedAt,
        haltedBy: $haltedBy,
        reason: $reason,
        expiresAt: $expiresAt,
        registeredBy: $registeredBy,
        verifyCommand: $verifyCommand
    }' > "$out"

echo "Registered HALT: $resource_path"
echo "  File: $out"
echo "  Halted by: $halted_by"
echo "  Reason: $reason"
[ "$verify_cmd" != "" ] && echo "  Verify cmd: $verify_cmd"
[ "$expires_at_json" != "null" ] && echo "  Expires: $expires_at_raw"
