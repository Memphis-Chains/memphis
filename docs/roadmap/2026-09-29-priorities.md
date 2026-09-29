# Priorytety — od ogółu do szczegółu (2026-09-29)

Stan realny: 13 568 bloków, 12 łańcuchów, runtime healthy, 30 open issues,
6 nieScalonych gałęzi, 7 timerów + 2 nowe (pon/wt 13:00).

## ZNAJDZISK: 3 issue są OPEN, ale fix już jest w main
| issue | fix w kodzie | commit |
|---|---|---|
| #628 embed atomic write (P0) | TAK | `11639a2`, `8808055` |
| #629 SSRF B1 (11 testów) | TAK | `f6bbb81` ADR-007 |
| #116 conventional commits | CZĘŚCIOWO | `0e09a5d` changelog |
| #626 trailing brace | W TOKU | PR #643, `fix/adr-009-writeblock-process-race` |
| #644 Tauri scaffold | W TOKU | PR #644 |
| #641 release v1.13.4 | W TOKU | PR #641 |

To znaczy: **prawdziwy P0 nie jest „do napisania", tylko „do domknięcia".**
Nikt nie zamyka issue po wdrożeniu fixu → board mówi jedno, kod drugie.
To samo dotyczy 4 nieScalonych gałęzi (dane w:UTC od 25.09).

## TIER 0 — zamknąć dziś, bez pytania (odwracalne, ~30 min)
- [ ] **0.1** Zamknąć #628 z komentarzem: fix `11639a2`+`8808055`, potwierdzone
- [ ] **0.2** Zamknąć #629 z komentarzem: fix `f6bbb81`, 21/21 testów
- [ ] **0.3** `feat/can-self-modify-computed` — **39 commitów** do przodu, `git merge-tree` → KONFLIKTY. Scalić z rozwiązywaniem konfliktów albo zamknąć z uzasadnieniem
- [ ] **0.4** ~~Wyłączyć grabber~~ **SKASOWANE** — `NRestarts=0`, `ActiveState=inactive`. Restart-storm już naprawiony. #646 do zamknięcia z komentarzem
- [ ] **0.5** SLO p99: `MEMPHIS_SLO_TURN_P99_MS=90000` (próg 3000ms hardcoded, realne p99=60672ms → fałszywy alarm)
- [ ] **0.6** journald 3.9 GB (nie 2.1 — stan z 2026-09-22). Wymaga `sudo journalctl --vacuum-time=7d` w TWOIM terminalu (brak TTY u mnie, decision o sudo)

## TIER 1 — kod, wtorkowa sesja (priorytet: dane > funkcje)
- [ ] **1.1** #626 trailing brace w chain block write — **NIEZALEŻNY**: `11639a2` rusza `crates/memphis-embed/pipeline.rs` + `embed-reindex.ts`, NIE chain-file-io. #626 to inna warstwa
- [ ] **1.2** #639 nightly-crystal Rust panic — pobrać artifact, zlokalizować test
- [ ] **1.3** #647 TUI input corruption (ANSI w paste) — security-adjacent, `sanitize_input()` w sanitize.rs + handle_paste
- [ ] **1.4** #638 weekly-runtime-kpi 403 — workflow permissions
- [ ] **1.5** Cron backupów raportuje „Command failed" mimo `tar -tzf` OK 8/8 — realne ryzyko, fałszywy alarm
- [ ] **1.6** `memphis readiness` 105 mismatchy (plan 3.1)
- [ ] **1.7** `dotenv.config()` bez `override: true` (env.ts:74) — zmienna z process.env wygrywa nad .env

## TIER 2 — infrastruktura, potem
- [ ] **2.1** scheduler-tools brak `job`/`period`/`timezone` — reflection/builtin taski nie da się dodać
- [ ] **2.2** pepper 25 znaków = „weak" — **rotacja unieważnia 12 wpisów vault**, decyzja operatora
- [ ] **2.3** embed index 26 MB — schemat niesprawdzony, nie nazywać regresją
- [ ] **2.4** 4 gałęzie bez PR (feat/phase-L-offline-invariant PR #642, 2 pozostałe)
- [ ] **2.5** docs/issues/ w .gitignore — pliki lokalne, nie w gicie
- [ ] **2.6** memphis-chain-draft poza repo, cytuje nieistniejący decision #216

## ODŁOŻONE (decyzja operatora)
- Anthropic — na żądanie właściciela
- `memphis_chain_draft` crypto/chain — po ustabilizowaniu rdzenia

## ZNAJDZISK O CRONACH
- `crontab` pusty. `grabber-feed-audit.sh` ma `# schedule: 0 6 * * *` w nagłówku
  ale **nigdzie nie zainstalowany** — nigdy się nie uruchomił.
- HTTP API `/api/journal` jest fail-closed bez `MEMPHIS_API_TOKEN` — cron nie zapisze
  do chainu tą drogą. Dlatego digesty idą Telegramem (`memphis telegram send --value`),
  a nie przez HTTP. To świadomy wybór, nie ograniczenie.
- Ustawione: `memphis-monday-admin.timer` (Mon 13:00) + `memphis-tuesday-code.timer` (Tue 13:00),
  `Persistent=true` (nadrabia po restarcie), `RandomizedDelaySec=180`.

## ANTY-CONFAB
**VERIFIED:** health healthy (13568 bloków/12 łańcuchów), 30 open issues z `gh issue list`,
commits `11639a2`/`8808055`/`f6bbb81` na origin/main, oba timery enabled
(`Mon 2026-10-05 13:00` / `Tue 2026-09-29 13:00`), `bash -n` czyste na obu skryptach.
**SKORYGOWANE po weryfikacji (3 błędy w mojej pierwszej wersji):**
1. `NRestarts=100203`/`2.1 GB` — z planu naprawczego, nie z teraz. Teraz `NRestarts=0`, inactive, journald 3.9 GB
2. `mergeable 0 konfliktów` — `git merge-tree` mówi KONFLIKTY, 39 commitów (nie 35)
3. „#628 pokrywa #626" — NIE, inne pliki (`crates/memphis-embed/src/pipeline.rs` vs chain-file-io)

**4. „#626 nie ruszyło się"** — ma PR #643 od 21.09, w toku. Board wyglądał na martwy, bo issue nie rusza, nie gałąź.
**5. Auto-detekcja „fix w main" (tuesday-code.sh)** — pierwsza wersja łapała `#628` wewnątrz `#631` i `#50` wewnątrz `#507` → **7 fałszywych alarmów**. Poprawione na regex `issue #NNN(?![0-9])` + `^fix|^feat|...`. Po poprawce `stale=0` (kontrola sensowności: #628 nadal w logu, ale zamknięty).

**UNVERIFIED:** czy f6bbb81 faktycznie zamyka 11 testów z #629 (grep commit ≠ wynik testu),
ile konkretnie plików koliduje w `feat/can-self-modify-computed` (merge-tree sam nie mówi ile).
**OUT OF SCOPE:** pisanie fixów — to wtorkowa sesja.
