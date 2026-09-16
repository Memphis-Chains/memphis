#!/usr/bin/env bash
# schedule: 0 6 * * *
set -euo pipefail

bash /home/memphis/memphis/scripts/usb-grabber-test.py /dev/video0 2 2>&1 | tail -20 >> /home/memphis/.memphis/logs/grabber-feed-daily.log
