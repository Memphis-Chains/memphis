#!/usr/bin/env bash
# schedule: 0 3 * * *
set -euo pipefail

#!/bin/bash
LOG=/tmp/dashboard-reseed.log
python3 /home/memphis/memphis/scripts/seed-dashboard-db.py >> "$LOG" 2>&1

# Rebuild the dashboard page from measured data.
#
# Measured 2026-10-29: the served page was a hand-written snapshot of the
# 2026-09-07 session. Its numbers ("17 zapisanych decyzji") were typed
# into the markup, so reseeding the database changed nothing the reader
# could see — the page stayed frozen while the chain grew by 453
# decisions. Generating the page here is what makes the reseed visible.
python3 /home/memphis/memphis/scripts/dashboard_report.py >> "$LOG" 2>&1
# The client view is a separate file: it carries the shop's measured
# state and the project's own decisions, and none of the runtime
# counters. The operator shares that one; the internal one stays local.
python3 /home/memphis/memphis/scripts/dashboard_report.py \
  --audience client \
  /home/memphis/public/sites-discovery/dashboard/client.html >> "$LOG" 2>&1

# Publish the client view to the web server.
#
# The client reads the page on the web, not on this machine, so a
# local rebuild that nobody publishes is the same frozen page as
# before — with one extra step to forget. The publish backs up, copies,
# verifies the generation stamp the server serves, and restores the
# backup if anything fails.
if [[ -f /home/memphis/.ssh/lhpl-active/config ]]; then
  SITES_SSH_HOST=lhpl \
  SITES_SSH_CONFIG=/home/memphis/.ssh/lhpl-active/config \
    bash /home/memphis/memphis/scripts/publish-client-dashboard.sh >> "$LOG" 2>&1 \
    || echo "client dashboard publish failed — page on the server left untouched" >> "$LOG"
else
  echo "client dashboard publish skipped: no ssh config for the web server" >> "$LOG"
fi

# Probe notifications via Telegram only on failures
if grep -q "err\|traceback" "$LOG"; then
  /home/memphis/memphis/scripts/telegram-notify.sh "⚠️ dashboard reseed errors: $(tail -5 "$LOG")"
fi
exit 0
