#!/usr/bin/env bash
# schedule: 30 23 * * *
set -euo pipefail

curl -s "https://api.telegram.org/bot8669740630:AAFhkP0iwylkbm5hYnwCOk3tKhwfXxbHX00/sendMessage" \
  -d "chat_id=1316033647" \
  -d "text=Hej Wodzu! 23:30 - czas iść spać! 🌙" \
  -d "parse_mode=HTML"
