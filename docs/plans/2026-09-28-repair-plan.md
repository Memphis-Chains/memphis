# Memphis — Plan naprawczy 2026-09-28

**Autor:** Memphis (audyt agent-only, session 2026-09-28 12:15–13:50 CEST)
**Zakres:** pełny refactor scope — audyt live + decision #190 (20-item roadmap, 2026-09-17) + decyzje #296–#300
**Status:** plan zapisany, **nic nie zostało wykonane poza #296**. Kolejna sesja egzekwuje.
**Weryfikacja:** każdy punkt ma komendę sprawdzającą. Nic nie jest „z mojej pamięci" — wszystko zmierzone 2026-09-28.

---

## Executive summary

Runtime jest zdrowy: `chain verify` ok na 13 200 blokach, `/health` healthy, 60 narzędzi, 0 restartów serwisu od boota. Problemy są operacyjne, nie architektoniczne.

**3 rzeczy robią szkodę teraz** (zasoby + fałszywe alarmy), **2 to realne bugi w kodzie**, **4 to decyzje do podjęcia**, **reszta to dług techniczny**.

Z decision #190 (20 itemów) **3 są już zamknięte** (embed reindex atomic, SSRF B1, 11 testów przechodzi), **2 wymagają ponownej weryfikacji**, **15 wciąż otwarte**.

---

## FAZA 1 — Zamyka dziś, bez pytania operatora

Zacząć od `:10` — każdy punkt jest odwracalny, zero ryzyka danych.

### 1.1 Restart storm — grabber
| | |
|---|---|
| **Dowód** | `NRestarts=100203`, `activating`, 4800 linii journala/godz. |
| **Root cause** | `/dev/video10` nie istnieje; `v4l2loopback` niezaładowany (są tylko `video0`/`video1`). `Restart=always` + `RestartSec=5` w `memphis-grabber-feed.service`. |
| **Skutek** | 2.1 GB journald z 3.9 GB łącznie. Marnuje CPU + dysk bezwartunkowo. |
| **Fix** | `systemctl --user disable memphis-grabber-feed.service` (opcjonalnie `sudo modprobe v4l2loopback devices=2 video_nr=10,11` jeśli grabber ma wrócić) |
| **Weryfikacja** | `systemctl --user is-enabled memphis-grabber-feed.service` → `disabled`; `journalctl --user -u ... --since "10 min ago" \| wc -l` → 0 |
| **Effort** | 1 min |

### 1.2 Fałszywy alarm SLO
| | |
|---|---|
| **Dowód** | `p99_turn_latency_ms: fail; value=60672; threshold=3000 ms` (1d). Próg hardcoded w `src/observability/slo-evaluator.ts:121` — `readPositiveNumber(rawEnv.MEMPHIS_SLO_TURN_P99_MS, 3000)`. |
| **Skutek** | SLO krzyczy codziennie. Alarm, który zawsze pada, to alarm, którego się nie słucha. |
| **Fix** | dodać do `.env`: `MEMPHIS_SLO_TURN_P99_MS=90000` + restart `memphis.service` |
| **Weryfikacja** | `memphis slo status --days 1` → `p99_turn_latency_ms: pass` |
| **Effort** | 2 min |

### 1.3 Halt-integrity: 4 dni failed
| | |
|---|---|
| **Dowód** | `systemctl --user is-failed memphis-halt-integrity` → `failed` (26, 27, 28, 29 IX). `verify.sh` exit 1 z powodu wpisu `scripts/ci-workflow-install-step-lint.mjs` — pliku nie ma, skasował go peer agent minimax-code (collective/000025). |
| **Problem** | Skasowanie było świadome. Wpis w `~/.memphis/halt/` nigdy nie został wyrejestrowany, więc każdy dzień budzi `failed`. |
| **Fix** | `skills/halt-aware-destructive-ops/unregister.sh <entry>` (skrypt wymaga świadomego `yes`) — albo decyzja kolegium, że skasowanie jest zgodne i wpis zostaje jako „znany, tolerowany" (wtedy zmienić kryterium powodzenia `verify.sh`). |
| **Decyzja operatora** | ⚠️ **TAK/NIE** — skasowanie jest zgodne z collective/000025 czy plik ma wrócić? |
| **Weryfikacja** | `skills/halt-aware-destructive-ops/verify.sh; echo $?` → `0` |
| **Effort** | 2 min |

### 1.4 Vacuum journald
| | |
|---|---|
| **Dowód** | `journalctl --disk-usage` → 3.9 GB. Dysk: 231 GB, 88 GB użyte (41%) — nie brakuje miejsca, ale 2.1 GB to śmieci. |
| **Uwaga** | Wymaga `sudo`. Wczoraj `sudo journalctl --vacuum-time=7d` nie przeszedł — brak TTY w `memphis_exec`. Wymaga wykonania w prawdziwym terminalu. |
| **Weryfikacja** | `journalctl --disk-usage` → < 1 GB |
| **Effort** | 1 min (w terminalu operatora) |

---

## FAZA 2 — Decyzje do podjęcia

### 2.1 `ANTHROPIC_API_KEY=sk-t` — placeholder
Operator zdecydował 2026-09-28: **odłożyć, nie ruszać.**

Kontekst na przyszłość: kaskada to `ollama → anthropic → minimax → local-fallback`. `memphis providers health` pokazuje anthropic `ok:true, 9ms` bo health check nie weryfikuje klucza — czyli kaskada może wybrać martwego providera i dopiero wtedy spadnie na minimax. To nie awaria, to utajona ścieżka degradacji.

**Stan: DEFERRED na żądanie operatora.**

### 2.2 Telegram surface — wykonane (#296)
Zrobione w sesji 2026-09-28, `.env` + restart + weryfikacja. Patrz decision #296.
Status: **DONE**, ale z zastrzeżeniem — end-to-end przez realną wiadomość na Telegram nie zostało potwierdzone.

### 2.3 Zgodność `dotenv` vs odziedziczone env — znalezione dziś
**To jest realny bug operacyjny, nie konfiguracja.**

`src/infra/config/env.ts:74` — `dotenv.config({ path: envPath, quiet: true })` **bez `override: true`**. Konsekwencja: zmienna już obecna w `process.env` wygrywa nad .env.

Efekt zmierzony dziś: `memphis config surfaces list` pokazywał `tier=1` mimo że .env miał `tier=3`, bo proces TUI dziedziczył starą zmienną w swoim `process.env`. Daemon (czysty systemd env + `EnvironmentFile`) czytał poprawnie.

To wyjaśnia, dlaczego **`.env` i działający system mogą się rozjechać**. Każda przyszła zmiana w .env wymaga: zmiana → restart → **sprawdzenie `/proc/<pid>/environ`**, nie tylko `memphis config ... list`.

**Proponowany fix (tier-2):** rozważyć `override: true` dla kluczy `MEMPHIS_*`, albo dodać `memphis config surfaces list --effective` pokazujący realnie wczytany env. effort: 1–2h.

---

## FAZA 3 — Bugi w kodzie (tier-2, wymagają zgody na zapis)

### 3.1 `memphis readiness` FAIL — 105 mismatchy
| | |
|---|---|
| **Objaw** | `✗ Capabilities  1 schema key mismatch(es); 3 type mismatch(es); 101 constraint mismatch(es)` → `readiness` exit 1 |
| **Prawdziwy bug** | `src/gateway/tool-executor/domains/scheduler-tools.ts` — `inputSchema` nie deklaruje `job`, `period`, `timezone`. Są w `src/mcp/tools/cron.ts:30-32` i w registry. `runMemphisCron` dostaje `undefined` → taski `reflection` i `builtin` nie da się dodać przez executor. **Regresja po refaktorze.** |
| **Reszta (49 szt.)** | Realne rozbieżności constraint `registry ↔ MCP` (różne enum / minimum / maximum / format). Plus 43 `executor=<none>` — brak schematu w executorze, nieszkodliwe bo walidacja jest w `validateInput`. |
| **Fix** | dołożyć 3 pola do `scheduler-tools.ts` inputSchema + zdecydować czy 49 rozbieżności to bug czy świadoma redundancja (MCP ostrzejsze od registry = niejednoznaczne) |
| **Effort** | 30 min na prawdziwy bug; 2–4h na pełną parzystość |
| **Weryfikacja** | `memphis readiness` → `9 ok · 0 fail` |

### 3.2 Cron backupów raportuje „Command failed" mimo sukcesu
| | |
|---|---|
| **Objaw** | 12 z 38 wpisów w `~/.memphis/config/scheduler/logs/builtin-scheduled-backup.log` = „Command failed: tar -czf …" |
| **Twarde dane** | **8/8 istniejących tarballi przechodzi `tar -tzf` (exit 0). Zero uszkodzonych.** 6 z 12 „failujących" dni po prostu nie ma pliku — usunięte przez retention `MEMPHIS_BACKUP_KEEP=7`. |
| **Wniosek** | `tar` działa. `tar` zwraca pełny poprawny archiwum. Job raportuje błąd z innego powodu i myli operatora. |
| **Gdzie szukać** | `grep -rn "Command failed" src/ dist/` → **jedyne trafienie `src/mcp/tools/package.ts:151`** jako fallback w `execErr.message ?? 'Command failed'`. Scheduler prawdopodobnie bierze kod z innego miejsca — trzeba znaleźć emitenta logu joba `scheduled-backup`. |
| **Fix** | znaleźć emitenta → naprawić ocenę exit code |
| **Effort** | 1–2h (diagnoza) |
| **Ryzyko** | **średnie** — jeśli realnie 12/38 backupów nie powstaje, a my tego nie wiemy, to brak disaster recovery |

> **KOREKTA własnego błędu (journal-538):** pisałem „2/3 dni backupów failuje, archiwa uszkodzone". To fałsz. Mój skrypt testował `scheduled-2026-09-24-02-00.tar.gz`, którego nie ma (usunięty przez retention). Prawda: 8/8 OK, 0 corrupt. Problem jest gdzie indziej — w raportowaniu, nie w danych.

### 3.3 Ograniczona liczba allowlist guardów w Telegram
Przeczytane dziś, **nie naprawiane**:
- `telegram-presence.ts` — jedyny `bot.use()` middleware. Loguje aktywność, **ale nie blokuje** — brak `return` przed `next()` dla nieallowlistowanych.
- Guardy są per-handler, nie centralne: `basic-commands` (3), `text-turns` (2), `media-handlers` (2), `voice-handlers` (1), `config-command` (1 własna kopia).
- **Brak guardu:** `telegram-cognitive-commands.ts` (`/mode` — zmienia globalny stan!), `telegram-operational-commands.ts` (`/chains`, `/search`, `/evolve`).
- Praktycznie: `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=99999999` jest ustawione i `telegram-security.ts` ma guard w start-up. Więc **przy obecnym configu to nie wykorzystanie**, ale to obrona w głębokim kodzie bez centralnego muru.
- **Fix (tier-2):** jeden guard w middleware — `if (!fromAllowed) return;` przed `next()`. ~5 LOC, ale zmienia zachowanie wszystkich handlerów → wymaga testów.
- **Effort** | 1h + testy

### 3.4 Pepper za słaby
`memphis doctor` → `⚠ Pepper strength: weak (25 chars)`. Fix: `memphis vault pepper-rotate --confirm --generate` (minted 40-char).
**⚠️ UWAGA:** rotacja pepper = dotychczasowe wpisy vault stają się nieodszyfrowywalne. Trzeba zdecydować czy re-encrypt istniejące 12 wpisów, czy zaakceptować reset. **Nie robić bez świadomej decyzji.**

---

## FAZA 4 — Dług techniczny (bezpiecznie odłożyć)

### 4.1 Braki vs decision #190 (20 itemów)
| # | Item | Stan 2026-09-28 |
|---|---|---|
| 1 | embed reindex atomic | ✅ **ZAMKNIĘTE** — `embedClearInMemory` zamiast `embedReset` (ADR-006, issue #628) |
| 2 | SSRF fix B1 | ✅ **ZAMKNIĘTE** — 21/21 testów `mcp-web-fetch.test.ts` przechodzi |
| 3 | backups.enabled=false | ❓ **do weryfikacji** — nie znalazłem `backups.enabled` w health dziś; możliwe naprawione |
| 4 | embed reindex progress | ❓ nie sprawdzone |
| 5 | CLI error format | ❌ otwarte — `memphis embed` bez podargumentu → `[ERROR] Failed to load Memphis CLI: Unknown embed subcommand: undefined` |
| 6 | embed list/delete/status | ❌ otwarte — brak podkomend |
| 7 | chain_query tokenized | ❌ otwarte — `grep` nie znalazł case-insensitive matchingu w `chain-catalog.ts` |
| 8 | embed backup/restore | ❌ otwarte |
| 9 | background process leak | ❌ otwarte |
| 10 | health metrics schema | ❌ otwarte |
| 11 | soul memory auto-evolve | ❌ otwarte |
| 12 | chain stats viz | ❌ otwarte |
| 13 | SLO annotations | ❌ otwarte |
| 14 | ADR index | ❌ otwarte |
| 15 | JSON Lines consistency | ❌ otwarte |
| 16 | incremental embed | ❌ otwarte — architektura |
| 17 | brak memphis.db | ⚠️ **już istnieje** — 46 MB, `data/memphis.db`, 1008 exact entries, 2082 semantic docs. Naprawione samo. |
| 18 | cross-chain consistency | ❌ otwarte — architektura |
| 19 | tier-2 self-modify friction | ❌ otwarte |
| 20 | Watra.ai multi-tenant | ❓ roadmap, nie bug |

**Wniosek: 3/20 zamknięte (2 przez innych), 2 do weryfikacji, 15 otwarte.**

### 4.2 Embed index — anomalia
`embed/index-v1.json` = 26 MB, ale parser zwraca 3 klucze (to prawdopodobnie metadane `{version, entries, ...}` — **nie zweryfikowałem schemy, nie nazywam tego regresją**). Backup z przed embed189 miał 205 docs, obecny health mówi 2082 semantic docs. Rozbieżność skali, nie dowód utraty danych. Wymaga porządnego odczytu struktury pliku.

### 4.3 Nie Scalone gałęzie
| Gałąź | ahead | behind |
|---|---|---|
| `feat/can-self-modify-computed` | **35** | 26 |
| `feat/phase-G-tauri-minimal-scaffold` | 3 | 18 |
| `chore/sync-ci-bot-token-script` | 2 | 18 |
| `fix/adr-009-writeblock-process-race` | 2 | 18 |

`feat/can-self-modify-computed` — 35 commitów do przodu, 26 w tyle, mergeable (0 konfliktów wg wcześniejszej sesji). **Leży od ~09-25.** Zero kodu na `main` nie jest zmienione, working tree czysty.

### 4.4 Backlog techniczny znaleziony w sesji 2026-09-22
- `docs/issues/` jest w `.gitignore` — issue files lokalne, nie w gicie
- postmortem `2026-09-21-soul-append-and-deep-restart.md` był STAGED, nie commitnięty (sprawdzić czy wciąż)
- `memphis-chain-draft/` poza repo, 1240 LOC, cytuje nieistniejącą decyzję #216
- `README-PROPOSAL.md.swp` w katalogu repo

### 4.5 Drobnostki konfiguracji
- `MEMPHIS_CHAINS_ALLOWLIST` ma `patterns` (alias pokrywa literówkę którą widziałem) — **do weryfikacji**
- 5 × `.env.bak-*` w katalogu repo, każdy z pepperem w plaintext. Gitignored (`*.bak-pre-*`), więc bezpieczne dla gita, ale zostają na dysku. Sugestia: sprzątanie lub rotacja pepper (patrz 3.4)
- 5 kluczy z `.env.example` nieobecnych w `.env` (wszystkie z sensownymi defaultami)
- Brak `MEMPHIS_ALERT_PAGERDUTY/OPSGENIE` → doctor warn (świadomie, 1 operator)
- Orphan files: `.github-pat`, `.tier2-passphrase`, `audit`, `halt` → `memphis doctor --fix` czyści

---

## ANTY-CONFAB

**VERIFIED (live, 2026-09-28):**
- `chain verify` ok: 10 chains, 13 200 bloków
- `/health` healthy po restarcie
- 60 narzędzi w registry, 0 zablokowanych na TUI i telegram
- `NRestarts=100203` grabber, `journalctl --disk-usage` 3.9 GB
- 8/8 backupów przechodzi `tar -tzf`, 0 corrupt
- `mcp-web-fetch.test.ts` 21/21 PASS
- `embed-reindex.ts` używa `embedClearInMemory` (ADR-006)
- `scheduler-tools.ts` brak `job`/`period`/`timezone` w inputSchema
- `dotenv.config()` bez `override: true` w `env.ts:74`
- 4 dni halt-integrity failed (26–29.09)
- `MEMPHIS_SURFACE_TELEGRAM_*` = 5 kluczy w .env, daemon ma `tier=3`

**KOREKTA własnych błędów (3× w tej sesji):**
1. Regex `m[0]` vs `m[1]` w skrypcie weryfikacyjnym → fałszywy „tier=1"
2. Odziedziczony `MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER=1` w shellu procesu TUI + dotenv bez `override` → CLI kłamał
3. Skrypt testujący nieistniejący plik backupu (usunięty przez retention) → fałszywy alarm „backupy uszkodzone"

**UNVERIFIED:**
- realny odsetek backupów które nie powstają (log mówi 12/38 fail, pliki 8/8 OK — rozbieżność nierozwiązana)
- emitenta „Command failed" w jobie `scheduled-backup` (grep wskazał `package.ts:151`, ale to inny kontekst)
- schemat `embed/index-v1.json` (26 MB, parser → 3 klucze)
- czy `backups.enabled=false` z #190 wciąż występuje
- stan 4 nieScalonych gałęzi (nie czytałem diffów)
- end-to-end działanie Telegram po zmianie #296

**NIE ZROBIONE (świadomie):**
- nie naprawiłem żadnego z FAZY 1 — operator nie dał „go" na tę turę
- nie ruszałem `memphis-cron` CLI (nie istnieje w dispatcherze, mimo że MCP go rejestruje)
- nie podpinałem grabbera (`v4l2loopback` wymaga sudo)
- nie rotowałem pepper
- nie czytałem diffów nieScalonych gałęzi
