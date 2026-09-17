#!/usr/bin/env bash
# schedule: 0 3 * * *
set -euo pipefail

#!/bin/bash
python3 /home/memphis/memphis/scripts/seed-dashboard-db.py >> /tmp/dashboard-reseed.log 2>&1
# Probe notifications via Telegram only on failures
if grep -q "err\|traceback" /tmp/dashboard-reseed.log; then
  /home/memphis/memphis/scripts/telegram-notify.sh "⚠️ dashboard reseed errors: $(tail -5 /tmp/dashboard-reseed.log)"
fi
exit 0
