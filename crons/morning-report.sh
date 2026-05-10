#!/usr/bin/env bash
#
# Memphis morning report — 2026-05-11
# Runs at 07:00 daily, sends summary to Telegram via `memphis telegram send`
#
set -uo pipefail

MEMPHIS_DATA="${MEMPHIS_HOME:-$HOME/.memphis}"
CHAIN_DATA="$MEMPHIS_DATA/chains"
LOG_DIR="$MEMPHIS_DATA/cron-logs"
LOG="$LOG_DIR/morning-report.log"
NOW=$(date '+%Y-%m-%d %H:%M')
TODAY=$(date '+%Y-%m-%d')
YESTERDAY=$(date -I -d "yesterday" 2>/dev/null || date -d "1 day ago" '+%Y-%m-%d')
CHAT_ID="${MEMPHIS_TELEGRAM_CHAT_ID:-1316033647}"

mkdir -p "$LOG_DIR"

log() { echo "[$NOW] $*" | tee -a "$LOG"; }

log "Building morning report for $TODAY"

HEALTH_JSON=$(memphis health --json 2>/dev/null || echo '{}')
SYSTEM_OK=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('overview',{}).get('pulse_health')=='healthy' else 'ISSUES')" 2>/dev/null || echo 'UNKNOWN')
BLOCKS=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('overview',{}).get('exact_entries','?'))" 2>/dev/null || echo '?')

JOURNAL_COUNT=$(ls "$CHAIN_DATA"/journal/*.json 2>/dev/null | xargs grep -l "$TODAY\|$YESTERDAY" 2>/dev/null | wc -l || echo 0)
DECISIONS_COUNT=$(ls "$CHAIN_DATA"/decisions/*.json 2>/dev/null | xargs grep -l "$TODAY\|$YESTERDAY" 2>/dev/null | wc -l || echo 0)
MEMORY_CHAINS=$(ls -d "$CHAIN_DATA"/*/ 2>/dev/null | wc -l || echo 0)
CRON_TASKS=$(ls "$MEMPHIS_DATA/crons"/*.sh 2>/dev/null | wc -l || echo 0)
ISSUES=$(ls "$MEMPHIS_DATA/stability-incidents/"*.json 2>/dev/null | xargs -I{} bash -c "grep -q '$TODAY\|$YESTERDAY' {} 2>/dev/null && echo {}" | wc -l || echo 0)
UPTIME_INFO=$(uptime 2>/dev/null | sed 's/.*load average://' || echo '')
LOAD=$(echo "$UPTIME_INFO" | awk '{print $1}' || echo '')

REPORT="Memphis - raport poranny $NOW

System: $SYSTEM_OK | $BLOCKS blokow w pamieci

Aktywnosc (wczoraj):
- $JOURNAL_COUNT wpisow w journal
- $DECISIONS_COUNT decyzji zapisanych
- $ISSUES incydentow systemowych

Status:
- $MEMORY_CHAINS lancuchow pamieci aktywnych
- $CRON_TASKS zadan cron skonfigurowanych
- Load: $LOAD

wygenerowany automatycznie"

# Send via memphis CLI (handles VAULT: resolution + --to/--value internally)
if memphis telegram send --to "$CHAT_ID" --value "$REPORT" 2>>"$LOG"; then
  log "Morning report sent OK"
else
  log "WARNING: Telegram send failed, report logged locally"
  echo "$REPORT" >> "$LOG"
fi

echo "=== Report sent: $NOW ===" >> "$LOG"