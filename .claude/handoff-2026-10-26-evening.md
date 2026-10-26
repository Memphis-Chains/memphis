# Session Handoff — 2026-10-26 (wieczór)

**Okres:** 2026-10-26 14:00 → 18:00 UTC
**Operator:** Wodzu (Marcin Kukla)
**Status:** 6 tematów domkniętych, 3 do decyzji operatora
**Gałąź:** `feature/durable-tool-journal` (= baza PR #688), przebudowana na `origin/main`

---

## 0. Czytelnik: kim jesteś

Jesteś jednym z trzech: **Memphis** (ten agent), **Codex** (agent terminalowy), albo
**operator po przerwie**. Fakty są z datami i komendami, nie z interpretacjami.

**UWAGA NA START:** w trakcie tej sesji pracowała **równolegle inna sesja** (ten sam
agent, inna powłoka). Zrobiła 4 commity, których ja nie pisałem, i przejmując kontrolę
nad repo musisz to sprawdzić: `git reflog` + `git status` + `git log --all --since`.
Patrz §6.

---

## 1. Sześć domkniętych tematów

### 1.1 Katalog modeli konta → gpt-6.1-sol (commity 2421ce18, 518c6f5a, 50a42371)

Operator: „lecisz". Trzy luki z mojego statusu, wszystkie domknięte.

**Co było zepsute:** TS potrafił już czytać `~/.codex/models_cache.json`, **Rust nie**.
Ten sam kontrakt w dwóch warstwach, dwie różne prawdy — dokładnie jak 21.10 (limit
konta TS↔Rust) i 25.10 (okno MiniMax TS↔Rust). Bez nawrotu: TS pokazywał 475000,
Rust pokazywał 1 050 000, a `gpt-6.1-sol` w ogóle nie był wybieralny w natywnym TUI.

**Co zrobiłem:**
- Katalog jest źródłem prawdy w obu warstwach, z **jednym czytnikiem na warstwę**,
  cache na (ścieżka, rozmiar, mtime). W Rustie dodatkowo: `Mutex`+`OnceLock`,
  z odzyskaniem z truciego (poisoned) locka.
- `read_account_context_window` **przebudowany na tym samym czytniku** — stary kod
  parsował `models_cache.json` **drugi raz, w osobnym miejscu**. Dwa parsery = dwa
  zestawy prawd o tym samym pliku, nawet w jednym języku.
- Okno = `min(deklarowane, konto)`. Konto może tylko **zaostrzać**.
- `gpt-6.1-sol-max` + preset, TUI trzyma preset przez tury (effort `max` nie ginie).

**Na żywo:** `memphis models list` → gpt-6.1-sol **ctx=475000** (nie 258400 jak
reszta, nie 1 050 000 jak sufit API). Prawdziwa tura: `GATE61` i `MAX61`.

### 1.2 Schema audit czyta kontrakt jak rejestr (commit 518c6f5a)

`memphis readiness` wychodził z **1** na zdrowym systemie. Trzy błędy czytnika:
- `gatewayHidden`: audyt wymagał schematu executora/MCP dla narzędzia native-only →
  `missingExecutorSchema=['memphis_vault_list']`. Ten sam defekt co surface audyt.
- `ZodLiteral` → zod v4 trzyma literal w `_def.values`; `z.union([z.literal(1),
  z.literal(2)])` to unia **liczb**, nie stringów.
- `ZodPreprocess` → zod v4 trzyma wnętrze w `_def.out`; bez rozwinięcia typ
  wychodził jako literał `"ZodPreprocess"`.

**UWAGA SEMANTYCZNA:** `report.ok` **NIE obejmuje** `constraintMismatches` — 108
mismatchów to raportowany szum, nie przyczyna awarii. Test nazywa się wprost
*„reports … drift without blocking runtime checks"*. Blokerów było 4, nie 108.

### 1.3 Executor crona przyjmuje to, co deklaruje rejestr (commit 50a42371)

Rejestr deklarował `timezone`, `period`, `job`; executor je **gubił**. Skutek: przez
gateway **nie dało się utworzyć taska `builtin`** — pięć jobów harmonogramu
nieosiągalnych dla modelu, bo `taskType: 'builtin'` nie było nawet w unii typów.

### 1.4 Przemianowanie natywnego crona (commity 3efb07d5, 65fe4640)

Operator: „pr 688 potem, teraz faza 2a. czytaj wiecej kodu".

Dwa narzędzia o jednej nazwie: natywny `memphis_cron` (pliki `~/memphis/crons/`) i
gatewayowy (zadania harmonogramu). Teraz: `memphis_cron` = gateway,
`memphis_cron_script` = natywny (native-only, `gatewayHidden`). Argument wyrażenia
cron to `cron` na obu powierzchniach (natywnie było `schedule`).

Skill `.claude/skills/usb-grabber-feed/SKILL.md` dokumentował komendę CLI, **której
nie ma** — poprawiony na realny mechanizm (plik z `# schedule:`).

### 1.5 Wyciek /tmp zamknięty (commity 00e29523 → 0cf8d592)

258 plików testowych tworzy własne `mkdtemp`, ~140 ich nie usuwa → **2145 katalogów,
212 MB na tmpfs (to RAM)**. Rozwiązanie systemowe: `TMPDIR` → katalog runu,
usuwany przez `globalSetup`.

**Operator wyrzucił ten commit z review** (57328aaf: *„Keep 00e29523 out: nested
Vitest runs inherit its temporary root, so a child teardown can remove the parent
run fixtures"*) — **to była prawda, ja tego nie wykryłem**. Odtworzyłem w 60 s.
Naprawa: własność z **PID-u w nazwie katalogu**, nie z „czy zmienna była ustawiona"
(ta wersja psuła cleanup górnego runu, bo config ustawia zmienną PRZED global-setup).

### 1.6 Runtime watch przestał alertować na starym błędzie (commit 86c0ee8d)

Operator: „na mail dostalem duzo powiadomien ze cos sie zfailowalo".

**Źródło maili: GitHub, nie Memphis.** Na hoście brak sendmail/msmtp/cron/kolejki
/var/mail; transport mailowy nie skonfigurowany; runtime-watch ma pustą allowlistę
Telegrama → 0 alertów. W GitHubie dziś 55 przebiegów, 15 `failure`.

**Prawdziwy powód alarmów:** runtime-watch alertował na **SLO 7-dniowym** → jeden
błąd providera z 25.10 16:48 (wyczerpanie kredytów, potem odnowione) trzymał
`provider_error_rate` na 7,1 % i alarmował co 6 h przez 6 dni. W oknie 24h: **0
błędów**.

**Fix:** alert = health + **ostatnia tura** + **ostatni provider call**. SLO 7d
zostaje w treści jako kontekst. Evaluator raportuje teraz `recent`.

---

## 2. Stan środowiska na koniec sesji

```
gałąź:    feature/durable-tool-journal (baza PR #688)
          0cf8d592 + 3efb07d5 + 65fe4640 + 86c0ee8d
          pushnięte: 86c0ee8d
upstream: origin/main = 769bd2d6 (po #692, #691, #694, #695, #696)
PR #688:  SCALONY 2026-10-26 15:27:47Z (merge commit d41dc90b) — moje commity
          0cf8d592 + 3efb07d5 + 65fe4640 są w main
PR #695:  SCALONY 2026-10-26 20:04:07Z (merge commit 96adfad7) — moje commity
          9db7e5d3 (fix alertów) + 94e851d9 + 81c4c6f8 (handoff) są w main.
          Checki przed merge: automerge, chain-invariant, quality-gate,
          cross-arch ubuntu-24.04-arm, cross-arch macos-latest — wszystkie SUCCESS.
          UWAGA: ten plik pisany był o 19:43 UTC, merge przyszedł 21 min później.
memphis:  zdrowy, 9 łańcuchów, 1290 bloków, verify ok:true (sprawdzone 26.10 20:37 UTC)
doctor:  47 pass / 13 warn / 0 fail
readiness: exit 0 ("63 tools; registry/executor/MCP/schema parity OK")
tests:   TS 3292/3292 (440 plików, 0 awarii), Rust operator 181 + TUI 123
         chain-invariant 9/9, ops-artifacts 228/228
zadania: runtime-watch → success; scheduled-backup → drill=pass (8,8 MB)
```

---

## 3. Otwarte na decyzje operatora

1. **Próg `p99_turn_latency_ms`** — 10 302 ms vs 3000 ms. To **realna** latencja
   modeli reasoning-effort-max na 2-rdzeniowej maszynie, nie anomalia. Próg to
   polityka operatora; override `MEMPHIS_SLO_TURN_P99_MS` istnieje. Ja **nie
   zmieniłem** progu — podniesienie bez zgody zamieniłoby fałszywy alarm na cichy
   brak alarmu.
2. **Powiadomienia e-mail GitHuba** — to konto operatora, nie mam dostępu.
   Zasada ode mnie: **jeden push na koniec serii prac**. Dziś 3 pushe = 9 checków
   = 9 maili, których GitHub i tak nie uruchomi z forka.
3. **Token GitHub** — classic, 22 zakresy (w tym `delete_repo`, `admin:org`).
   Do `Memphis-Chains/memphis` mam tylko `pull`. Zamiana na fine-grained:
   <https://github.com/settings/tokens> → Fine-grained → Only select repositories →
   `Memphis-Chains/memphis` → Contents RW + Pull requests RW.
4. ~~**Approval maintainera dla PR #695**~~ — **ZAMKNIĘTE 26.10 20:04 UTC**
   (PR scalony, checki przeszły). Z tej listy zostaje tylko fakt, że GitHub nie
   uruchamia workflowów z forka: każdy push generuje 3 checki bez jobów.

---

## 4. Zasady wyłapane dziś — nie powtarzać

| Zasada | Skąd |
|---|---|
| Alert o **stanie** a alert o **trendzie** to dwie różne rzeczy. SLO 7-dniowe jako bramka alertowania zamienia jeden błąd w sześć dni alarmów. | runtime-watch |
| Zmierz, co dokładnie leży w oknie, zanim napiszesz fix. Tu: 1 błąd w 7 dniach, 0 w 24h. | provider_error_rate |
| Trzeci stan GitHuba: odmowa uruchomienia z forka = `failure` z **zerem jobów** i pustym logiem. To nie błąd kodu. | 9 z 15 failure |
| Mój własny fix błędu może mieć **drugi błąd tego samego rodzaju**. Naprawa „czy zmienna była ustawiona" zepsuła cleanup górnego runu. | TMPDIR ownership |
| Nazwa funkcji bywa obietnicą. Sprawdź, czy błąd jest **twój**, zanim zaczniesz szukać go u kogoś innego — `runMephisSloStatus` vs `runMemphisSloStatus`. | moja literówka w edycji |
| Hardcoded liczby w kodzie chroniącym hardcoded liczby zawodzą tak samo jak strona, którą chronią. | `sync-site-metrics`, 59/62 |
| Wartość `exposures: ['native','gateway']` może być prawdą o **nazwie** i fałszem o **narzędziu**. | natywny vs gateway cron |
| Równoległa sesja w tym samym repo to **wzorzec**, nie wyjątek. Dwa razy w jednej dobie: `git reflog` + `git status` przed commitem. | cudza praca 25.10 23:45 i 26.10 |
| Operator potrafi wskazać błąd, którego sam nie wykryłem. Jego wskazówka była precyzyjna — odtworzyłem ją w 60 sekund. | 00e29523 wyrzucony |
| „Około 108 błędów" to często 1 błąd × 108 miejsc. Sprawdź, co wchodzi w `report.ok`, zanim zaplanujesz naprawę. | constraint drift |
| Zmiana nazwy narzędzia to zmiana **kontraktu widocznego dla modelu** — rozstrzygnięcie należy do operatora. | faza 2a |

---

## 5. Czego dziś NIE zrobiliśmy (dla uczciwości przyszłej sesji)

- **Nie zmieniliśmy progu p99** — świadomie, do decyzji operatora.
- **Nie wyczyściliśmy ręcznie `lastStatus` tasku `builtin-scheduled-backup`** — stary
  błąd z 02:00 wczoraj; odświeży się o 02:00. `memphis schedule run` wymaga
  passphrase, a edycja stanu poza API to obejście bramki.
- **Nie wyłączyliśmy maili GitHuba** — to konto operatora.
- **Nie przeszliśmy przez PR #695** — to zdanie napisane o 19:43 UTC było
  prawdziwe w chwili pisania; **PR #695 został scalony o 20:04 UTC**
  (merge commit 96adfad7, checki SUCCESS). Obie PR-y są już w `origin/main`.
- **Nie zrobiliśmy `memphis chain verify` dla katalogów `chains/*.backup-*`** — są
  zarchiwizowane i usunięte (patrz journal-77).
- **Nie naprawiliśmy `quarterly-gate`** — to zaplanowana porażka: skrypt Q2
  jeszcze nie istnieje, bo Q2 dopiero zaczyna się.

---

## 6. Równoległa sesja — jak to sprawdzić

W trakcie 26.10 inna sesja zrobiła 4 commity (`89b2e8d7`, `616a4c31`, `19fa98f4`,
`8db46684`) i przejęła gałąź. Zasady:

```bash
git reflog -8                      # kto, co, kiedy
git log --oneline --all --since="2026-10-26 00:00"
git status --short                 # cudze pliki w working tree
```

Cudza praca z 25.10 23:45 (tool-surface-audit gatewayHidden) została w końcu
scalona przez operatora jako `19fa98f4` — jej wersja `cli.ts` miała **duplikat
importu**, a `render.ts` wersję bez reguły stdio. HEAD jest w obu lepszy.

---

## 7. Jak wejść w następną sesję

```bash
cd ~/memphis
git checkout feature/durable-tool-journal
git fetch origin && git log --oneline origin/main -3

# stan pamięci
memphis health --json | head -c 600
memphis doctor | tail -3
memphis chain verify --chain journal

# stan zadań
python3 -c "import json;[print(t['id'],t['lastStatus']) for t in json.load(open('/home/memphis/.memphis/config/scheduler/tasks.json'))]"
```
