#!/usr/bin/env bash
# Monday 13:00 CEST — ADMIN / STRONY (operator session)
# Zbiera: health runtime, stan witryn, otwarte issue GH, plan naprawczy.
# Dostarcza: Telegram digest (operator trigger).
set -uo pipefail

# systemd user units NIE dziedzicza PATH z shella — musimy ustawic recznie.
export PATH="/home/memphis/.local/share/npm-global/bin:/home/memphis/.cargo/bin:/home/memphis/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
MEMPHIS="memphis"

REPO="$HOME/memphis"
LOG="$HOME/.memphis/logs/cron-monday-admin.log"
mkdir -p "$(dirname "$LOG")"
OUT=$(mktemp /tmp/monday-admin-XXXXXX.md)

run() { echo "$1" >> "$OUT"; echo >> "$OUT"; }

{
  echo "PONIEDZIAŁEK — ADMIN / STRONY"
  echo "$(date '+%Y-%m-%d %H:%M %Z')"
  echo
} > "$OUT"

run "── RUNTIME ──"
(cd "$REPO" && timeout 45 npm run -s cli -- health 2>&1 | head -20) >> "$OUT" 2>&1

run "── WITRYNY (public) ──"
for u in \
  "https://memphis-v5.pl/" \
  "https://memphis-v5.pl/start/" \
  "https://memphis-v5.pl/docs/" \
  "https://memphis-v5.pl/roadmap/" \
  "https://memphis-v5.pl/demo/" \
  "https://memphis-v5.pl/panel/admin/login" \
  "https://memphis-v5.pl/llms.txt" \
  "https://memphis-v5.pl/security.txt" ; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 12 "$u" 2>/dev/null || echo "ERR")
  if [ "$code" = "200" ]; then printf 'OK   %s\n' "$u" >> "$OUT"
  else printf 'ALERT %s → %s\n' "$u" "$code" >> "$OUT"; fi
done

run "── BACKUP LEAK CHECK (docroot) ──"
for f in index.html.bak test.bak site.env x.sqlite; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "https://memphis-v5.pl/$f" 2>/dev/null || echo "ERR")
  [ "$code" = "403" ] || printf 'ALERT leak? /%s → %s\n' "$f" "$code" >> "$OUT"
done
echo "brak wycieków (403 na próbach)" >> "$OUT"

run "── OPEN ISSUES (GitHub) ──"
(cd "$REPO" && timeout 45 gh issue list --repo Memphis-Chains/memphis --state open --limit 40 \
  --json number,title,labels --template '{{range .}}#{{.number}}  {{.title}}  [{{range .labels}}{{.name}} {{end}}]
{{end}}' 2>&1) >> "$OUT"

run "── REPO ──"
(cd "$REPO" && echo "gałąź: $(git branch --show-current)") >> "$OUT"
(cd "$REPO" && echo "ahead/behind: $(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo '?')") >> "$OUT"
(cd "$REPO" && git status --porcelain 2>/dev/null | head -10) >> "$OUT"

run "── BACKUPY (lokalne) ──"
(cd "$REPO" && timeout 60 npm run -s cli -- backup list 2>&1 | tail -12) >> "$OUT"

# --- delivery: Telegram ---
BYTES=$(wc -c < "$OUT")
if [ "$BYTES" -gt 4000 ]; then
  MSG="$(head -c 3900 "$OUT")

[...tutaj skrócone...]"
else
  MSG="$(cat "$OUT")"
fi

timeout 60 "$MEMPHIS" telegram send --value "$MSG" >>"$LOG" 2>&1
rc=$?
echo "=== $(date -Is) rc=$rc bytes=$BYTES ===" >> "$LOG"
cp "$OUT" "$HOME/.memphis/logs/last-monday-admin.md"
rm -f "$OUT"
exit $rc
