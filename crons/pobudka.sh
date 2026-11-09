#!/usr/bin/env bash
# schedule: 39 8 * * *
#
# WHY THIS WAS REWRITTEN
# ----------------------
# Measured 2026-11-06: this task failed 11 out of 11 runs, every day since
# it was created. Two independent defects, both measured:
#
#   1. The body read the vault with
#          jq -r '.entries[] | select(.key=="telegram_bot_token") | .id'
#          /home/memphis/.memphis/vault-entries.json
#      The vault file is a JSON ARRAY of entries, not an object with an
#      `entries` key — jq answered `Cannot index array with string
#      "entries"` and exited 5, which `set -euo pipefail` turned into a
#      failed task before the first curl. And even with the right path,
#      `.id` is the ENTRY ID ("entry-1782912661481"), never the token:
#      the token lives encrypted in the `encrypted` field. This script
#      could not have sent anything even on the day it was written.
#
#      The delivery now goes through `memphis telegram send`, the only
#      path that resolves the vault-backed token. Same reason
#      scripts/systemd/failure-alert.sh uses it: MEMPHIS_TELEGRAM_BOT_TOKEN
#      in .env is the literal "VAULT:telegram_bot_token", and Telegram
#      answers that with 404.
#
#   2. The body appended to /home/memphis/memphis/journal/pobudka.log — a
#      directory that does not exist in the repository. The log now goes
#      to ~/.memphis/logs/, where the other operator-side logs live.
#
# The content was also a stale list from 2026-09-17: it still asked the
# operator for a GitHub PAT he has had in the vault since 2026-09-12, and
# pointed at a branch that no longer exists. The digest below is measured
# live instead, so it cannot rot.
set -uo pipefail

export PATH="/home/memphis/.local/share/npm-global/bin:/home/memphis/.local/bin:$PATH"
REPO=/home/memphis/memphis
LOG_DIR=/home/memphis/.memphis/logs
mkdir -p "$LOG_DIR"

cd "$REPO" || exit 1

issues="$(gh issue list --limit 8 --state open --json number,title --jq '.[] | "  #\(.number) \(.title)"' 2>/dev/null)"
prs="$(gh pr list --limit 8 --state open --json number,title --jq '.[] | "  PR #\(.number) \(.title)"' 2>/dev/null)"
slo="$(memphis slo status --days 1 --json 2>/dev/null | jq -r '.slos[] | "  \(.name): \(.status)"' 2>/dev/null)"
failed="$(jq -r '.[] | select(.lastStatus == "failed") | "  \(.name) — \(.lastError // "brak szczegółów")"' /home/memphis/.memphis/config/scheduler/tasks.json 2>/dev/null)"

MESSAGE="🌅 Memphis — przebudka, $(date '+%Y-%m-%d %H:%M %Z')

🔴 Otwarte issue (GitHub)
${issues:-  brak}

🟡 Otwarte PR-y
${prs:-  brak}

📊 SLO (ostatnie 24h)
${slo:-  brak danych}

⏰ Zadania harmonogramu w błędzie
${failed:-  brak}

Co robimy najpierw dziś?"

if ! command -v memphis >/dev/null 2>&1; then
  echo "POBUDKA_FAILED reason=memphis-cli-not-found"
  exit 1
fi

SEND_OUT="$(timeout 60 memphis telegram send --value "$MESSAGE" 2>&1)"
SEND_RC=$?
echo "$SEND_OUT" >> "$LOG_DIR/pobudka.log"

if [ "$SEND_RC" -ne 0 ]; then
  echo "POBUDKA_FAILED rc=$SEND_RC"
  exit 1
fi

echo "[cron:pobudka] digest delivered at $(date -Iseconds)" >> "$LOG_DIR/pobudka.log"
exit 0
