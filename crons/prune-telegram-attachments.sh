#!/usr/bin/env bash
#
# Memphis telegram-attachments retention — REV2 Temat 1 follow-up (PR #596 W1).
#
# PR #596 persisted Telegram photo/document attachments under
# `<MEMPHIS_DATA_DIR>/state/telegram-attachments/` so the agent can
# re-discover them in subsequent turns. Coder B's #596 review flagged
# that the comment claimed "a retention cron prunes >7d-old files
# separately" but the cron wasn't wired. This script is that cron.
#
# Default policy: unlink files with mtime > 7 days. Operator can
# override via env:
#   MEMPHIS_TG_ATTACHMENTS_RETAIN_DAYS=14  ← keep 2 weeks instead
#   MEMPHIS_TG_ATTACHMENTS_DRY_RUN=1       ← log + skip unlink
#
# Cron suggestion (operator's user crontab):
#   17 4 * * * /home/memphis/memphis/crons/prune-telegram-attachments.sh \
#     >> ~/.memphis/logs/prune-telegram-attachments.log 2>&1
#
# Skipped silently when the attachments dir doesn't exist (fresh
# install, or operator hasn't received a Telegram attachment yet).

set -euo pipefail

DATA_DIR="${MEMPHIS_DATA_DIR:-$HOME/.memphis}"
ATTACH_DIR="${DATA_DIR%/}/state/telegram-attachments"
RETAIN_DAYS="${MEMPHIS_TG_ATTACHMENTS_RETAIN_DAYS:-7}"
DRY_RUN="${MEMPHIS_TG_ATTACHMENTS_DRY_RUN:-0}"

now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ ! -d "$ATTACH_DIR" ]; then
  echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.skipped\",\"reason\":\"dir-missing\",\"dir\":\"$ATTACH_DIR\"}"
  exit 0
fi

# Validate retention value (integer 1..365).
if ! [[ "$RETAIN_DAYS" =~ ^[0-9]+$ ]] || [ "$RETAIN_DAYS" -lt 1 ] || [ "$RETAIN_DAYS" -gt 365 ]; then
  echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.invalid-config\",\"retain_days\":\"$RETAIN_DAYS\"}" >&2
  exit 2
fi

# Collect candidates first so we can audit-log the set before mutation.
mapfile -t candidates < <(find "$ATTACH_DIR" -maxdepth 1 -type f -mtime +"$RETAIN_DAYS" -print 2>/dev/null || true)
total_files=$(find "$ATTACH_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l)
candidate_count=${#candidates[@]}

if [ "$candidate_count" -eq 0 ]; then
  echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.clean\",\"total_files\":$total_files,\"retain_days\":$RETAIN_DAYS}"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  for f in "${candidates[@]}"; do
    echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.dry-run\",\"file\":\"$f\"}"
  done
  echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.summary\",\"would_prune\":$candidate_count,\"total_files\":$total_files,\"retain_days\":$RETAIN_DAYS,\"dry_run\":true}"
  exit 0
fi

pruned=0
errors=0
for f in "${candidates[@]}"; do
  if rm -f -- "$f" 2>/dev/null; then
    pruned=$((pruned + 1))
    echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.unlinked\",\"file\":\"$f\"}"
  else
    errors=$((errors + 1))
    echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.unlink-failed\",\"file\":\"$f\"}" >&2
  fi
done

echo "{\"ts\":\"$now\",\"event\":\"telegram-attachments.prune.summary\",\"pruned\":$pruned,\"errors\":$errors,\"total_files\":$total_files,\"retain_days\":$RETAIN_DAYS}"

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
