#!/usr/bin/env bash
# Tuesday 13:00 — KOD MEMPHIS
# Generuje PRIORYTETY Z REALNEGO STANU (nie hardcoded) -> docs/roadmap/current-priorities.md
# Ten sam plik jest source of truth dla sesji kodowania.
# Dostarcza: Telegram digest z checklistą weryfikacji dla operatora.
set -uo pipefail

# systemd user units NIE dziedzicza PATH z shella — musimy ustawic recznie.
export PATH="/home/memphis/.local/share/npm-global/bin:/home/memphis/.cargo/bin:/home/memphis/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
MEMPHIS="memphis"

REPO="$HOME/memphis"
LOG="$HOME/.memphis/logs/cron-tuesday-code.log"
PRIO="$REPO/docs/roadmap/current-priorities.md"
mkdir -p "$(dirname "$LOG")" "$REPO/docs/roadmap"
TMP=$(mktemp /tmp/tuesday-XXXXXX.md)
GHP="gh -R Memphis-Chains/memphis"

# --- surowe dane: JEDEN gh run list + JEDEN issue list + JEDEN git log ---
echo "zbieram stan..."
$($GHP issue list --state open --limit 100 --json number,title > /tmp/tui-issues.json 2>/dev/null)
$GHP pr list --state open --limit 30 --json number,title,mergeable,headRefName,updatedAt > /tmp/tui-prs.json 2>/dev/null
$GHP run list --limit 20 --json name,conclusion,workflowName > /tmp/tui-runs.json 2>/dev/null
(cd "$REPO" && git log origin/main --format='%s' -400 > /tmp/tui-log.txt 2>/dev/null)
(cd "$REPO" && git branch -r --format='%(refname:short)' 2>/dev/null | grep -v HEAD | grep -v 'origin/main$' > /tmp/tui-branches.txt)

python3 - "$REPO" "$PRIO" "$TMP" <<'PY'
import json,sys,subprocess,os,datetime
repo,prio,tmp=sys.argv[1],sys.argv[2],sys.argv[3]
def load(p,d):
    try: return json.load(open(p))
    except Exception: return d
issues=load('/tmp/tui-issues.json',[]); prs=load('/tmp/tui-prs.json',[])
runs=load('/tmp/tui-runs.json',[]); branches=[l.strip() for l in open('/tmp/tui-branches.txt') if l.strip()]
try: log=open('/tmp/tui-log.txt',errors='ignore').read()
except Exception: log=''

def sh(c):
    try: return subprocess.run(c,shell=True,capture_output=True,text=True,timeout=90,cwd=repo).stdout.strip()
    except Exception: return ''

# STALE: issue otwarte, a w main jest commit fixujacy DOKLADNIE ten numer.
# Regex z granica (?<![0-9]) i (?![0-9]) — inaczej #50 lapie sie w #507.
# Wymagamy slowa 'issue #NNN' (nie '#NNN' jako PR) + slowa fixujacego.
import re as _re
fixwords=_re.compile(r'^(fix|feat|harden|atomic|guard|regression|implement|refactor|perf)',_re.I)
stale=[]
for i in issues:
    n=i['number']
    pat=_re.compile(r'issue #%d(?![0-9])'%n,_re.I)
    hits=[s for s in log.splitlines() if pat.search(s) and fixwords.match(s.strip())]
    if hits: stale.append((n,i['title'],hits[0][:70]))

ahead=[]
for b in branches:
    n=sh(f"git rev-list --count origin/main..{b} 2>/dev/null") or '?'
    if n in ('0',''): continue
    d=sh(f"git log -1 --format=%cs {b} 2>/dev/null")
    # UWAGA: merge-tree --write-tree wypisuje SHA drzewa NAWET przy konfliktach.
    # `&& echo MERGEABLE` dal falszywe "MERGEABLE" dla wszystkich galezi.
    # Konflikty sa w komunikatach 'CONFLICT (content): ...' na stderr/stdout.
    mt=sh(f"git merge-tree --write-tree origin/main {b} 2>&1")
    nconf=mt.count('CONFLICT')
    ok=f"MERGEABLE" if nconf==0 else f"CONFLICT x{nconf}"
    ahead.append((b,n,d,ok,nconf))

fails={}
for r in runs:
    if r.get('conclusion')=='failure':
        k=r.get('workflowName') or r.get('name')
        fails[k]=fails.get(k,0)+1

today=datetime.date.today().isoformat()
L=[]
L.append(f"# Priorytety — tydzień {today} (auto, generowane z realnego stanu)")
L.append("")
L.append(f"Źródło: `cron tuesday-code.sh` · issue {len(issues)} otwartych · PR {len(prs)} · gałęzię {len(ahead)}")
L.append("")
L.append("> **Ten plik jest źródłem prawdy dla sesji kodowania.** Generowany wtorek 13:00")
L.append("> z realnego stanu (issue, PR, gałęzie, CI). Nie edytuj ręcznie.")
L.append(">")
L.append("> **ZASADA SESJI KODOWANIA:** pierwszy krok = przeczytaj `docs/roadmap/current-priorities.md`.")
L.append("> Zrób pozycje z A i B. Zatrzymaj się na F — decyzje operatora, nie zgaduj.")
L.append("> Po zrobieniu: odznacz checkbox, dopisz co zrobiłeś pod daną pozycją.")
L.append("")
L.append("## A. Do zrobienia TERAZ (bez pytania, odwracalne)")
L.append("")
L.append("- [ ] Zamknąć issue z fixem już w main (patrz sekcja B)")
L.append("- [ ] Przejrzeć PR-y czekające na review (sekcja C)")
L.append("- [ ] Podjąć decyzję o gałęziach z konfliktami (sekcja D)")
L.append("")
if stale:
    L.append("## B. Issue OTWARTE, ale fix JUŻ JEST w main — do zamknięcia")
    L.append("")
    for n,t,c in stale: L.append(f"- [ ] **#{n}** {t[:72]}")
    L.append("")
    L.append("  *Dowód (commit na origin/main):*")
    for n,t,c in stale: L.append(f"  - #{n}: `{c}`")
    L.append("")
else:
    L.append("## B. Issue otwarte, ale fix już w main")
    L.append("")
    L.append("Brak — albo wszystko zrobione, albo fixy nie mają `#NNN` w commicie.")
    L.append("")
L.append("## C. PR do review")
L.append("")
if prs:
    for p in prs: L.append(f"- [ ] **#{p['number']}** [{p.get('mergeable','?')}] {p['title'][:64]}")
else: L.append("Brak otwartych PR.")
L.append("")
L.append("## D. Gałęzie poza main")
L.append("")
L.append("| gałąź | commity | ostatni | stan |")
L.append("|---|---|---|---|")
for b,n,d,ok,nc in ahead:
    files=""
    if nc:
        mts=sh(f"git merge-tree --write-tree origin/main {b} 2>&1 | grep -A0 'CONFLICT' | head -{min(nc,6)}")
        names=set()
        for line in mts.splitlines():
            if 'Merge conflict in' in line:
                names.add(line.split('Merge conflict in')[-1].strip())
        files=" → " + ", ".join(sorted(names)[:4])
    L.append(f"| `{b.replace('origin/','')}` | +{n} | {d} | {ok}{files} |")
L.append("")
L.append("## E. CI — czerwone")
L.append("")
if fails:
    for k,v in sorted(fails.items(),key=lambda x:-x[1]): L.append(f"- **{v}×** `{k}`")
else: L.append("Wszystko zielone w ostatnich 20 przebiegach.")
L.append("")
L.append("## F. DO WERYFIKACJI PRZEZ OPERATORA")
L.append("")
L.append("Też nie umiem rozstrzygnąć sam — potrzebuję Twojej decyzji:")
L.append("")
L.append("- [ ] Pepper vaulta (rotacja unieważnia 12 wpisów) — robić czy nie")
L.append("- [ ] `sudo journalctl --vacuum-time=7d` (brak TTY u mnie)")
L.append("- [ ] Rozwiązywać konflikty w gałęziach z sekcji D czy zamknąć")
L.append("- [ ] Rotacja tajnych (`master-key-rotate`)")
L.append("")
L.append("## G. Plan długoterminowy")
L.append("")
L.append("- [ ] `docs/plans/*-repair-plan.md` — fazy 1–4")
L.append("- [ ] `docs/roadmap/2026-09-29-priorities.md` — rozbudowana wersja z kontekstem")
L.append("")
open(prio,'w').write("\n".join(L)+"\n")
open(tmp,'w').write("\n".join(L)+"\n")
print(f"stale={len(stale)} prs={len(prs)} ahead={len(ahead)} fails={len(fails)}")
PY

# --- commit priorytetów ---
cd "$REPO" && git add -A docs/roadmap/current-priorities.md 2>/dev/null
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -q -m "chore(priorities): auto-generowana lista na wtorek $(date -I)" 2>/dev/null
  git push -q origin HEAD:refs/heads/main 2>&1 | tail -1
fi

# --- delivery ---
BYTES=$(wc -c < "$TMP")
if [ "$BYTES" -gt 3900 ]; then
  MSG="$(cat "$PRIO" | head -c 3400)

[pełna wersja: docs/roadmap/current-priorities.md]"
else
  MSG="$(cat "$TMP")"
fi
timeout 60 "$MEMPHIS" telegram send --value "$MSG" >>"$LOG" 2>&1
rc=$?
echo "=== $(date -Is) rc=$rc bytes=$BYTES ===" >> "$LOG"
cp "$TMP" "$HOME/.memphis/logs/last-tuesday-code.md"; rm -f "$TMP"
rm -f /tmp/tui-*.json /tmp/tui-log.txt /tmp/tui-branches.txt
exit $rc
