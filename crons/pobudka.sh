#!/usr/bin/env bash
# schedule: 39 8 * * *
set -euo pipefail

#!/bin/bash
# Pobudka: morning digest z loose ends z sesji 2026-09-17
# Wysylka do Telegram + journal entry

cat > /tmp/pobudka.txt << 'EOF'
☀️ DOBRANOC → DOBRY RANO, Wodzu.

Loose ends do domkniecia z sesji 2026-09-17:

🔴 GITHUB ISSUE PUSH
- /home/memphis/memphis/docs/issues/memphis-tui-input-bug.md gotowy
- Push przez gh CLI gdy dasz PAT
- Komenda: gh issue create --title "Memphis-TUI corrupts stdin input..." --body-file docs/issues/memphis-tui-input-bug.md

🔴 TUI INPUT SANITIZATION FIX
- Tier-2, czeka na passphrase + snapshot
- 3 pliki do patch: sanitize.rs (dodac sanitize_input), app.rs (handle_paste + handle_key), test
- Branch: fix/tui-input-sanitization

🟡 USB BOOT TEST
- /dev/sdc z PARTUUID a68a15c8-01, CD001 + MBR
- Sprawdz fizycznie czy laptop botuje z USB

🟡 SZCZEPAN — OTWARTE PYTANIA DO CIEBIE (5)
1. "Doloze sie zeby bylo w porzadku" — co konkretnie?
2. Search UI Can-Am/Polaris (decision #121) — nadal istnieje pod innym URL czy martwy?
3. 100 PLN/mies — od kiedy? faktura? JDG/PSA?
4. 13% prowizji — za ruch z jakich zrodel (FB Ads only? IG? organic?)
5. Ile miesiecy juz masz ten uklad?

🟡 BACKLOG
- Umowa pisemna ze Szczepanem = blocker przed Meta Ads
- Nagrywki do /extra (video placeholder czeka na Twoje wideo)

Co robimy najpierw dziś?
EOF

# Wyslij do Telegram (token z vault, chat_id z config)
TOKEN=$(jq -r '.entries[] | select(.key=="telegram_bot_token") | .id' /home/memphis/.memphis/vault-entries.json 2>/dev/null)
# Fallback: uzyj znany chat ID (z allowlist)
CHAT_ID="1316033647"

if [ -n "$TOKEN" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="${CHAT_ID}" \
    -d parse_mode=HTML \
    -d text="$(cat /tmp/pobudka.txt)" > /dev/null 2>&1
fi

# Journal entry
echo "[cron:pobudka] Daily digest sent at $(date -Iseconds)" >> /home/memphis/memphis/journal/pobudka.log

exit 0
