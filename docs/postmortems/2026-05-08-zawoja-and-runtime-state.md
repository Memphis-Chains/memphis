# Postmortem 2026-05-08 — Zawoja demo + post-demo runtime diagnostic

**Operator:** Marcin Kukla (Wodzu)
**Captured by:** Memphis (Opus 4.7, planning instance)
**Source:** Operator dictation post-Zawoja, runtime diagnostic from second TUI instance (MiniMax-M2.7)

---

## Część 1 — Zawoja demo (2026-05-06, Hotel Jawor)

### Wynik
- **Przemówienie:** OK
- **Demo na żywo:** porażka

### Co poszło nie tak (operator's words)
1. Memphis uruchomiony za późno — brak warm-up, brak smoke przed sceną
2. Zero testu na maszynie demo przed publicznością
3. Brak Plan B (fallback) — gdy live nie odpalił, nie było czego pokazać

### Lekcje (4 reguły demo-readiness)
1. **Uruchomić min. 1 dzień wcześniej** — Memphis musi już chodzić, indeksy ciepłe
2. **Testować demo PRZED wejściem** — pre-demo smoke + rehearsal-mode obowiązkowe
3. **Zawsze mieć Plan B** — zapisany happy-path / screencast / static reply ready
4. **Pokazywać że DZIAŁA, nie że perfekcyjny** — demo charyzma = dowód użyteczności, nie technologiczny show; błędy są OK bo pokazują że to żywe AI, nie scenariusz

### Wnioski systemowe (kierunek na kod)
- `memphis demo arm` CLI — odmawia start jeśli warunki niespełnione
- `memphis demo rehearse <scenario>` — odgrywa fixed-input zanim live
- `memphis demo plan-b record/play` — zapisuje + serwuje fallback ścieżkę
- `/status` ma badge **DEMO READY ✅ / NOT ARMED ❌**

---

## Część 2 — Runtime diagnostic (2026-05-08)

Druga instancja Memphisa (TUI, MiniMax-M2.7) wykonała self-diagnostic. Co działa, co nie:

### ✅ Działa
| Komponent | Status |
|---|---|
| Memphis TUI | ✅ pid 14303, 14230 |
| Rust bridge | ✅ connected |
| Telegram gateway | ✅ ready, 1 allowlisted user |
| Ollama (cogito:3b) | ✅ |
| Chains | ✅ 11 aktywnych, 5769 bloków |
| Memory (exact + semantic) | ✅ 2291 entries, 2053 docs |
| Vault | ✅ 6 haseł, integrity OK |
| Self-reflection loop | ✅ aktywna co 12h |

### 🔴 Problemy (4)

#### P1 [CRITICAL] — Telegram raport nie wysyła się
```
can't parse entities: Can't find end of the entity starting at byte offset 442
```
- **Skutek:** raport z 2026-05-08 nie poszedł
- **Hipoteza:** niezbalansowany markdown w treści raportu (`*`, `_`, `` ` ``, `[`)
- **Surface:** prawdopodobnie Telegram sender przy `parse_mode=MarkdownV2` lub `Markdown`
- **Fix kierunek:** sanitize/escape przed sendem albo `parse_mode=HTML` z poprawnym escape

#### P2 [CRITICAL] — Backup archive corrupt
```
restore-drill FAILED — backup may not be restorable
```
- **Skutek:** brak operacyjnej kopii zapasowej; padnie dysk → utrata wszystkiego
- **Fix kierunek:** zidentyfikować który archive failuje, re-run backup, dodać alert + automated weekly drill blocker

#### P3 [HIGH] — Duplicate Memphis workers
```
pid 12618 — Channel gateway started (Telegram)
pid 14230 — Channel gateway started (Telegram)
```
- **Skutek:** konfliktowe zapisy do chains, race conditions, podwójne API hits
- **Fix kierunek:** singleton lockfile (PID file w `data/memphis.pid`); start refusuje gdy żywy PID; graceful kill starszego

#### P4 [MEDIUM] — Confabulation detector firing + provider timeout
```
rule A: memphis_slo_status → "✅ ok"
rule D: memphis_journal → reply quotes none
invalid provider stream response: timed out reading response
```
- **Skutek:** anti-confab guards triggers + MiniMax stream times out
- **Hipoteza:** rule A/D są over-eager dla SLO/journal text; lub real confab; provider timeout to MiniMax SSE issue
- **Fix kierunek:** sample log entries → triage: false positive vs real → tune rules; bump SSE timeout albo retry once

---

## Repo state (snapshot)

- Branch: `integration/pre-demo-2026-05-06` — 44 commits ahead of `main`
- 21 open PR-ów (#478–#498), wave plan w `docs/operator/merge-wave-plan.md`
- Untracked: `crons/simple-reminder.sh` (operator deferral pattern), `docs/zawoja-2026-przemowienie.md` (speech, archive candidate)
- Last release: v1.8.0 (2026-05-02)
