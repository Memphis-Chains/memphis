#!/usr/bin/env bash
# Tuesday 13:00 CEST — KOD MEMPHIS (continuous self-work)
# Zbiera: CI/nightly, merge queue, testy, chain integrity, tech debt z planu.
# Dostarcza: Telegram digest z KOLEJNOŚCIĄ (priorytetami), nie listą.
set -uo pipefail

REPO="$HOME/memphis"
LOG="$HOME/.memphis/logs/cron-tuesday-code.log"
mkdir -p "$(dirname "$LOG")"
OUT=$(mktemp /tmp/tuesday-code-XXXXXX.md)
run() { echo "$1" >> "$OUT"; echo >> "$OUT"; }

{
  echo "WTOREK — KOD MEMPHIS"
  echo "$(date '+%Y-%m-%d %H:%M %Z')"
  echo
} > "$OUT"

run "── CI (ostatnie przebiegi) ──"
(cd "$REPO" && timeout 60 gh run list --repo Memphis-Chains/memphis --limit 12 \
  --json name,status,conclusion,createdAt,displayTitle \
  --template '{{range .}}{{.status}}\t{{.conclusion}}\t{{.name}}\t{{.displayTitle}}{{"\n"}}{{end}}' 2>&1 | head -14) >> "$OUT"

run "── NIGHTLY / WORKFLOWS Z RED FLAG ──"
(cd "$REPO" && timeout 45 gh run list --repo Memphis-Chains/memphis --limit 20 \
  --json name,conclusion --jq '[.[]|select(.conclusion=="failure")]|group_by(.name)|map({n:.[0].name,c:length})|sort_by(-.c)[]|"\(.c)x  \(.n)"' 2>&1 | head -10) >> "$OUT"

run "── MERGE QUEUE (nieScalone gałęzie) ──"
(cd "$REPO" && for b in $(git branch -r --format='%(refname:short)' 2>/dev/null | grep -v HEAD | grep -v 'origin/main$'); do
  n=$(git rev-list --count origin/main.."$b" 2>/dev/null || echo '?')
  d=$(git log -1 --format='%cs' "$b" 2>/dev/null || echo '?')
  printf '%-45s +%-4s %s\n' "$b" "$n" "$d"
done 2>&1 | head -14) >> "$OUT"

run "── PR (otwarte) ──"
(cd "$REPO" && timeout 45 gh pr list --repo Memphis-Chains/memphis --state open \
  --json number,title,mergeable,reviewDecision \
  --template '{{range .}}#{{.number}} {{.mergeable}} {{.reviewDecision}}  {{.title}}{{"\n"}}{{end}}' 2>&1 | head -12) >> "$OUT"

run "── CHAIN INTEGRITY ──"
(cd "$REPO" && timeout 90 npm run -s cli -- chain verify 2>&1 | tail -8) >> "$OUT"

run "── REPO ──"
(cd "$REPO" && echo "gałąź: $(git branch --show-current)") >> "$OUT"
(cd "$REPO" && echo "ahead origin/main: $(git rev-list --count origin/main..HEAD 2>/dev/null)") >> "$OUT"
(cd "$REPO" && echo "dirty: $(git status --porcelain 2>/dev/null | wc -l) plik(ów)") >> "$OUT"

run "── PLAN NAPRAWCZY (otwarte fazy) ──"
(cd "$REPO" && grep -E '^#{2,3} ' docs/plans/*-repair-plan.md 2>/dev/null | tail -22) >> "$OUT"

run "── TEST GATE (szybki) ──"
(cd "$REPO" && timeout 120 npm run -s cli -- tui --check-only 2>&1 | tail -5) >> "$OUT"

# Priorytet na górze — reszta szczegóły
PRIO="$HOME/.memphis/logs/prio-tuesday.md"
{ echo "PRIORYTET NA TEN TYDZIEŃ:"; echo " 1. PR do review: $(cd "$REPO" && gh pr list --repo Memphis-Chains/memphis --state open --json number --jq 'length' 2>/dev/null || echo '?') szt.";
  echo " 2. Issue z fixem już w main (zamknąć): #628 #629";
  echo " 3. Gałąź +39 z konfliktami: feat/can-self-modify-computed";
  echo " 4. CI: $(cd "$REPO" && gh run list --repo Memphis-Chains/memphis --limit 20 --json conclusion --jq '[.[]|select(.conclusion=="failure")]|length' 2>/dev/null || echo '?') fail z 20";
  echo " 5. Plan: docs/roadmap/*-priorities.md"; } > "$PRIO" 2>&1

BYTES=$(wc -c < "$OUT")
if [ "$BYTES" -gt 3900 ]; then
  MSG="$(head -c 3800 "$OUT")

[[pełny digest: $HOME/.memphis/logs/last-tuesday-code.md]"
else
  MSG="$(cat "$OUT")"
fi
timeout 60 memphis telegram send --value "$MSG" >>"$LOG" 2>&1
rc=$?
echo "=== $(date -Is) rc=$rc bytes=$BYTES ===" >> "$LOG"
cp "$OUT" "$HOME/.memphis/logs/last-tuesday-code.md"
rm -f "$OUT"
exit $rc
