#!/usr/bin/env bash
# halt-aware-destructive-ops/unregister.sh
# Remove a HALT entry (requires conscious trigger).
#
# Usage:
#   ./unregister.sh <resource-path>

set -euo pipefail

HALT_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/halt"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <resource-path>" >&2
    exit 64
fi

resource_path="$1"
filename=$(printf '%s' "$resource_path" | sha256sum | cut -c1-16)
target="$HALT_DIR/$filename.json"

if [ ! -e "$target" ]; then
    echo "No HALT entry for: $resource_path" >&2
    echo "Files in $HALT_DIR:" >&2
    ls -la "$HALT_DIR" 2>&1 | head >&2
    exit 1
fi

echo "Current HALT entry:"
cat "$target"
echo "---"
read -r -p "Confirm unregister? (type 'yes' to proceed): " confirm
if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
fi

rm "$target"
echo "Removed HALT: $resource_path"
