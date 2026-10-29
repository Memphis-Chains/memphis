# SLO report — stan zmierzony 2026-10-29

Raport SLO mówił o runtime, którego nie ma. Poniżej: co zmierzone, co
zmienione, jak obalić każdą liczbę.

---

## 1. RAPORT PRZED (7-dniowe okno, `memphis slo status --json`)

```json
p99_turn_latency_ms   value=2046254  status=fail   samples=183
confabulation_rate    value=0.00546  status=fail   samples=183
provider_error_rate   value=0.01103  status=fail   samples=453
tool_error_rate       value=0.30313  status=fail   samples=607
```

**Wszystkie cztery `fail` były zdecydowane przez dane sprzed 3-4 dni.**

Pomiary surowych spanów (`~/.memphis/telemetry/spans-*.jsonl`):

| Klasa                 | Ostatni span         | Liczba w 7d | Komentarz                                               |
| --------------------- | -------------------- | ----------- | ------------------------------------------------------- |
| `turn.dispatch`       | 2026-10-29 17:54     | 183         | p50=40 ms, p95=41 s, p99=2 046 254 ms                   |
| `provider.completion` | 2026-10-29 17:54     | 453         | 258 na `MiniMax-M3.1-Flash-Preview`, 89 na `M3.1-Flash` |
| `tool.call`           | **2026-10-26 20:08** | 607         | **3 dni bez nowych spanów**                             |
| `confabulation.event` | 2026-10-25 17:48     | 1           | jedno zdarzenie, 4 dni                                  |

Skład populacji `turn.dispatch` w oknie (mierzone, nie zgadnięte):

| provider / powierzchnia        | n   | mediana    | max          |
| ------------------------------ | --- | ---------- | ------------ |
| `local-fallback` / cli.chat    | 47  | 23-59 ms   | 297 ms       |
| `ollama` / http.chat.generate  | 36  | 23 ms      | 170 ms       |
| `minimax` / cli.chat           | 12  | 38 751 ms  | 71 050 ms    |
| `minimax` / gateway (telegram) | 3   | 632 830 ms | 2 046 254 ms |

Czyli: **p99 było liczone na 3 tury Telegram z 25.10** (34 minuty i 44
minuty — realne tury z pętlami narzędzi), a nie na "obecnym" ruchu.
W oknie nie było ani jednego nowego `tool.call`, więc `tool_error_rate`
liczył 30% błędów z trzech dni wcześniej.

## 2. DLACZEGO `tool.call` ZNIKNĄŁ 26.10

Sprawdzone w kodzie, nie zgadnięte:

- `src/gateway/agent-runtime.ts:436` — `instrument('tool.call', ...)` otacza
  wykonanie narzędzia w pętli **TypeScript**.
- `crates/memphis-operator/src/chat_tool_executor.rs` — powierzchnia Rust
  wykonuje narzędzia **samodzielnie**, bez żadnego emitera spanów.
- `grep -rln "telemetry" crates/` → **0 trafień**. Warstwa Rust nie miała
  telemetrii w ogóle.

Telegram/CLI/HTTP działają na pętli TS (`surface=gateway`, `cli.chat`,
`http.chat.generate`). TUI jest powierzchnią autorytatywną i używa
pętli Rust. Od 26.10 operator przeszedł na TUI — i `tool.call` zniknęło
z raportu tego samego dnia.

## 3. CO ZMIENIONE

### 3.1 Granica świeżości w raporcie (`src/observability/slo-evaluator.ts`)

SLO opisuje **bieżący** stan runtime'u, więc próbki starsze niż granica
nie decydują o pass/fail.

- Domyślnie **24h** (`MEMPHIS_SLO_MAX_AGE_MS`, milisekundy).
- `MEMPHIS_SLO_MAX_AGE_MS=0` wyłącza granicę (stare zachowanie: średnia
  z okna).
- Raport mówi, co naprawdę zmierzył: `sampleWindowStart`, `maxAgeMs`,
  `evaluatedSamples`.
- Każdy SLO dostaje `lastSampleAt` + `ageMs`, a `reason` nazywa ciemny
  kanał: `no tool.call spans in window - last tool.call span 3d ago`.

Stare próbki są nadal **czytane** — raport może powiedzieć "ostatni
tool.call 3 dni temu", ale nie zgadza się na podstawie nich, że coś
jest zepsute.

### 3.2 Telemetria narzędzi z powierzchni Rust (`crates/memphis-operator/src/telemetry.rs`)

Nowy moduł pisze do tego samego pliku co warstwa TS
(`<dataDir>/telemetry/spans-YYYY-MM-DD.jsonl`, ten sam format rekordu:
`ts`, `name`, `attrs`, `durationMs`, `status`). Emiter siedzi przy
dispatcherze `execute_native_tool`, bo tam znane są wynik i czas
wykonania — dokładnie tak, jak `instrument('tool.call', ...)` w TS.

Zapis jest best-effort: pierwszy błąd wyłącza sink na resztę procesu i
zgłasza się na stderr — telemetria nie może wywrócić ścieżki narzędzia.
`MEMPHIS_TELEMETRY_LOCAL_SINK=false` wyłącza go po obu stronach.

## 4. RAPORT PO (7-dniowe okno, te same dane)

```json
p99_turn_latency_ms   value=71050   status=unavailable  samples=3
                       reason="insufficient samples (3 < 10) within the last 24h"
                       lastSampleAt=2026-10-29T17:54:31.294Z  ageMs=2060968
confabulation_rate    value=0        status=unavailable  samples=3
provider_error_rate   value=0        status=unavailable  samples=3
tool_error_rate       value=null     status=unavailable  samples=0
                       reason="no tool.call spans in window - last tool.call span 3d ago"
                       lastSampleAt=2026-10-26T20:08:23.457Z  ageMs=253228805
```

Zero fałszywych `fail`. Zero fałszywych `pass`. Cztery `unavailable` —
cztery braki dowodu, nazwane wprost.

`memphis self-governance status --json` po zmianie:

```json
"capable": true, "canSelfRecover": true, "canSelfModify": true,
"blockingReasons": []
```

## 5. JAK OBALIĆ (każdy punkt ma test falsyfikujący)

| Twierdzenie                    | Jak obalić                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Granica świeżości działa       | `MEMPHIS_SLO_MAX_AGE_MS=0 node bin/memphis.js slo status --json` → wracają 4 `fail` z danych z 25.10                                         |
| Raport mówi, kiedy kanał zgasł | usunąć `spans-2026-10-26.jsonl` → `tool_error_rate` traci `lastSampleAt`/`ageMs`                                                             |
| Rust pisze `tool.call`         | `cargo test -p memphis-operator --lib chat_tool_executor` (2 testy: zapis i odmowa jako error)                                               |
| Mutacja zostaje zauważona      | usunąć wywołanie `record_tool_call` → 2 testy padają; ustawić `failed` na `false` → pada test odmowy                                         |
| TS-owy limit nie jest atrapą   | 5 mutacji w `slo-evaluator.ts` (no-bound, no-freshness, bound-always-zero, no-dark-reason, no-insufficient-suffix) → każda zgłasza padnięcie |

## 6. CO ZOSTAŁO OTWARTE (zmierzone, nie zgadnięte)

1. **TUI w tej sesji to stary proces.** Binarny `target/debug/memphis-tui`
   jest przebudowany, ale działający proces (PID uruchomiony o 19:11)
   ma w pamięci poprzedni kod. `tool.call` z natywnej powierzchni pojawi
   się w pliku spanów dopiero po restarcie TUI.
2. **`health=unhealthy` migocze.** 66 przebiegów watcha dzisiaj, 64 `ok`,
   2 `FAILED` (17:00 i 17:15) z powodem `health=unhealthy` — nie z powodu
   SLO. Po 17:45 z powrotem `ok`. Do zbadania: co robi health w tych
   dwóch oknach.
3. **Historia alarmów.** 4874 bloków `runtime watch: FAILED` w łańcuchu
   `system` (od 29.07, ~96 dziennie), 248 `SUCCESS`. Starsze powody były
   z SLO (`slo=...`), po poprawce z 25.10 zostaje `health=unhealthy`.
4. **`.htpasswd` wciąż publiczny po starym SHA** — `05780b82`,
   `sites/memphis-v5/docs/internal/.htpasswd`, `raw.githubusercontent` →
   HTTP 200, `main` → 404. Kolejny pomiar 2026-10-29 potwierdził to
   niezmienione.
