#!/bin/bash
set -euo pipefail

JOURNAL="$MEMPHIS_DATA/chains/journal"
DECISIONS="$MEMPHIS_DATA/chains/decisions"
LOG="$MEMPHIS_DATA/cron-logs/daily-reflection.log"

mkdir -p "$(dirname "$LOG")"

{
  echo "=== Daily Reflection: $(date -I) ==="
  YESTERDAY=$(date -I -d "yesterday")
  
  echo "--- Journal entries: $YESTERDAY ---"
  grep -l "$YESTERDAY" "$JOURNAL"/*.json 2>/dev/null | wc -l || echo "0"
  
  echo "--- Decisions: $YESTERDAY ---"
  grep -l "$YESTERDAY" "$DECISIONS"/*.json 2>/dev/null | wc -l || echo "0"
  
  echo "=== Done ==="
} >> "$LOG" 2>&1

echo "[$(date -Iseconds)] Daily reflection complete"
