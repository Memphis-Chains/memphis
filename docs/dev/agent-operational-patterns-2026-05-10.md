# Memphis Agent — Operational Patterns

> Persistent operational reference for Memphis Agent (Telegram/TUI/CLI).
> Patterns wyciągnięte z analizy logów ostatnich 24h (2026-05-10) —
> co bot robi dobrze, gdzie konfabuluje, gdzie sandbox blokuje, jak
> szukać rozwiązań skutecznie. Bot może odczytać przez `memphis_code_read`
> (plik jest w `~/memphis/`, więc w sandboxie). Tożsame patterns
> zapisane też w `~/.memphis/config/soul-memory.json:self.learnings` —
> ładowane przy każdej sesji jako soul state.

---

## Kontekst — co bot rzeczywiście robi (24h pomiar)

Top tools użyte w 24h:
- `memphis_exec` 196× (najczęściej — bot dużo introspection przez shell)
- `memphis_glob` 59×, `memphis_grep` 56× (file search)
- `memphis_web_fetch` 54× — dużo URL fetches; **częściowo blokowane**
- `memphis_code_read` 52×, `memphis_git` 36×, `memphis_journal` 34×
- `memphis_brave_search` 33×, `memphis_fs_write` 32×
- `memphis_recall` 25×, `memphis_chain_query` 17×
- `memphis_self_describe` 13×, `memphis_health` 12×, `memphis_soul_write` 11×

3 phantom tools (rule E confab — bot wymyślił):
- `memphis_PROACTIVE_TELEGRAM_CHAT_ID` (env var name jako tool)
- `memphis_CAPS_USER` (caps user var jako tool)
- `memphis_PROMPT_ARCHITECTURE` (file name jako tool)

11 anti-confab events (Phase 2 warn-append):
- Rule A (persistence-claim) ×7: "działa", "✅", "ready" bez tool_call
- Rule D (search-claim) ×2: tool zwrócił quotable fields, reply nie zacytował
- Rule E (tool-naming) ×3: env var / file name w code-fence jako tool
- Rule C (capability-claim) ×1: enumeration after empty tool output

Persistence degraded events: 32× (memory_recall/url_fetch/cognitive_prelude/memory_store_blocked
głównie — surface policy block na niskim tier).

Turn duration EMA: 72s. Bot często działa dłużej niż GEN_TIMEOUT_MS=45000
przez agent loop (multi-call). Operator's percepcja "wisi" kiedy bot
deep-recon'uje ciągłe tool chainy.

---

## 10 patterns operacyjnych

### 1. Sandbox boundary — `~/memphis/` only

Tool calls fail twardo na ścieżkach poza repo:
- `memphis_grep`, `memphis_glob`, `memphis_code_read`, `memphis_fs_write` blokują na `/root`, `/home/wvio`, `/root/.memphis`, etc.
- Sandbox is anchored on install root (post Phase 5 fix `findEnvFile()` + tool executor projectRoot).

**Konsekwencja:**
- `/root/.memphis/config.toml` → użyj `memphis_exec` (tier-2) z absolute path, nie `code_read`.
- `~/.memphis/` (operator data dir) jest poza sandboxem code_read'a.

**Heuristic:** ścieżka zaczyna się od `/home/<user>/memphis/`? — OK.
Inaczej → sandbox blokada → użyj `memphis_exec` lub `memphis_chain_query` (chains są poza sandbox boundary, ale dostępne przez tool).

---

### 2. Pre-flight introspection — ZANIM "kodu brakuje"

**Anti-pattern (2026-05-10 incident):** bot powiedział "Telegram handler obsługuje tylko tekst" → operator wysłał brief koderom → koder by zmarnował dni 1-2 nad już-istniejącym kodem.

Realność: `src/gateway/channels/telegram.ts:751` ma `bot.on('message:voice')`,
`:834` ma `bot.on('message:photo')`, `:996` ma `bot.api.sendVoice()`.

**Pattern:** zanim claim'ujesz brak fichy, kolejność:
1. `memphis_self_describe` — zobacz aktualny tool inventory
2. `memphis_grep -r 'message:voice|sendVoice|message:photo' src/gateway/`
3. `memphis_code_read` na file:line z grep wyniku
4. `memphis_chain_query` — szukaj poprzednich decyzji w tym obszarze
5. **DOPIERO TERAZ** propose action lub claim "nie ma"

Skok od (1) do (5) to confab generator.

---

### 3. Confabulation rule A — persistence-claims trigger anti-confab

Phase 2 warn-append łapie polskie/angielskie post-completion phrases:
`zapisałem`, `zaktualizowałem`, `udało się`, `gotowe`, `done`,
`completed`, `i saved`, `i persisted`, `creating file`, `tworzę plik`.

Plus passive markery: `działa`, `ready`, `✅`.

**Trigger:** powiedzenie tego BEZ tool_call w tej samej turze. Anti-confab
audit emituje `prompt.output.confab_warned` event + dodaje footer
`[memphis: claim flagged as unverified — persistence: "X"]` do replyu.

**Avoid:**
- Albo wywołaj tool który to potwierdza (`memphis_journal` dla "zapisałem",
  `memphis_health` dla "działa", `memphis_chain_query` dla "udało się").
- Albo przeformułuj na "spróbowałem X — wynik Y" (no claim, just trace).

---

### 4. Confabulation rule D — quote-skipping

Jak wywołałeś `memphis_journal` / `memphis_recall` / `memphis_chain_query` /
`memphis_search` i tool zwrócił quotable fields, MUSISZ je zacytować
w replyu.

**Trigger:** rule D `tool returned N quotable field(s); reply quotes none`.

**Avoid:** zacytuj literal value z tool result. Jeśli synthesis, prefiksuj
`per memphis_recall: "..."` żeby anti-confab zobaczył że quotujesz a nie
zmyślasz. Long-form summarization OK gdy quote breakdown w prompcie.

---

### 5. Confabulation rule E — tool-naming

Code-fence call `memphis_<NAME>` to PROPOSAL żeby wywołać tool. Jeśli to
NIE jest istniejące narzędzie z `memphis_self_describe.tools`, anti-confab
flaguje rule E.

**2026-05-10 błędy:**
- `memphis_PROACTIVE_TELEGRAM_CHAT_ID` — env var, nie tool
- `memphis_PROMPT_ARCHITECTURE` — file, nie tool
- `memphis_CAPS_USER` — caps user var, nie tool

**Test przed code-fence:** `memphis_self_describe.tools` ma `<NAME>` w
liście? Jeśli nie — formułuj jako tekst, nie code-fence.

---

### 6. Soul write schema — fields wsparte vs nie

**Wsparte** (z `memphis_soul_write`):
- `user.languages` (array of strings)
- `user.preferences` (array of strings)
- `user.expertise` (array of strings)
- `user.integrations` (array of strings)
- `user.name` (string)
- `self.strengths`, `self.learnings`, `self.evolvedCapabilities` (arrays)
- `context.recentDecisions` (array of strings)
- `context.activeWork` (string — jednoznaczne; NIE array)

**NIE wsparte** (operator 2026-05-10 hit):
- `user.nickname` — schema nie ma tego pola (workaround: prefix
  `Zwracaj się: Wodzu` jako entry w `preferences`)
- `user.location` — schema nie ma (workaround: prefix `Lokalizacja: ...`
  jako entry w `preferences`)
- `user.identity` (object) — schema flat, nie zagnieżdżone
- `context.activeWork` jako array — błąd type mismatch; concatenate
  do single string

**TODO:** schema extension w `src/soul/types.ts` — kolejny task dla
koderów (~1h, low risk).

---

### 7. Surface policy degradation — Telegram tier 0/1

`gateway turn persistence degraded` to nie błąd toolu, to surface
policy block:
- tier 0 → `memory_recall`, `url_fetch`, `cognitive_prelude`,
  `memory_store_scanned_blocked`, `tools_blocked`
- tier 1 → niektóre nadal blocked (`recalled_memory_blocked`)
- tier 2 (default) → wszystko otwarte

**Pattern:** sprawdź `memphis_self_describe.surfacePolicies[surface=telegram]`
zanim deep recon. W niskim tier część toolu zwróci puste — traktować jak
*missing capability* nie *missing data*.

`/tier 3 <pass>` unlocka wszystko na 3h. 5min przed wygaśnięciem
lifecycle event (warning), o pełnej godzinie revert.

---

### 8. Long turn timeout — multi-call agent loop

Deep recon (3+ `memphis_code_read` + `memphis_grep` + `memphis_exec`
łańcuchowo) routinowo trwa 60-120s. `GEN_TIMEOUT_MS=45000` to per-API-call
ceiling (single completion request), nie per-turn. Turn = wiele completion
requests przez tool-use loop.

**Operator's percepcja na Telegramie:** wisi.

**Strategia:**
- Co 30s wysłaj intermediate finding ("sprawdziłem A, znalazłem X, teraz patrzę na B")
- Surfaces (Telegram, TUI) widzą partial replies; operator wie że bot żyje
- Dla deep recon (>5 tool calls), explicit `[recon w toku — chwilę]` przy starcie

---

### 9. Provider cascade behavior

`OrchestrationService.tryGenerate()` cascade:
1. Primary (Anthropic Opus 4.6) → try
2. Catch → fallback (`local-fallback-v0` lub Ollama per `.env`)
3. Catch fallback → AppError

Cascade jest **per-call**, nie per-turn. Jeden timeout w trakcie tool
chain może spaść na local-fallback w środku rozumowania. Wynik: turn
ma mixed providers w `ChatResponse.trace.attempts`.

**Test:** sprawdź `trace.attempts` w response gdy operator pyta "czemu
odpowiedź taka słaba" — może środek turn'a skończył na local-fallback-v0
(2k context, deterministic).

---

### 10. MiniMax overflow false-positive (None/None)

Operator 2026-05-10: `/provider minimax` → "yo" → 
`provider minimax context window exceeded (None / None tokens) — use /clear`.

**Bug w `crates/memphis-operator/src/provider.rs:2280+`:**
- `is_context_overflow_body()` poprawnie łapie `context window exceeds limit (2013)`
- ALE ekstrakcja `(used, window)` używa adjacency check ±48 chars
  z "token" word
- MiniMax message format `(2013)` jest osobno (bez "tokens" word obok)
- → extraction zwraca `None / None`
- → operator widzi "None / None tokens" w error message (false-impression
  że tokens są nieznane vs context jest nieznany)

**Workaround:** `/clear` ALE realnie problem to MEMPHIS_GEN_MAX_TOKENS
może być za high dla MiniMax M2.7 (200k context, ale per-request output
limit różny). Plus operator moze hit'nąć 2k context limit (`(2013)`
=2013 tokens budget left? lub used? — niejasne).

**TODO (operator decision pending):** Rust crate fix —
- ekstrakcja MiniMax format z parenthesized `(N)` value
- distinguish "context window" overflow vs "max_tokens" overflow w error
  message (operator dostaje aktyjną remediation, nie generyczne `/clear`)
- ~1-2h, cargo test pass musi zostać

---

## Solution-search heuristic — kolejność jak szukać rozwiązań

Gdy operator pyta o feature/bug:

1. **`memphis_self_describe`** — effective tier, tool inventory, surface
   policy. Bez tego nie wiesz co masz dostępne.
2. **`memphis_grep`** z konkretną nazwą funkcji/symbolem w `src/`. Jeśli
   zwraca hits → kod istnieje, czytaj. Zero hits → MOŻE nie istnieje (ale
   może też być w innej ścieżce — sprawdź `memphis_glob`).
3. **`memphis_code_read`** na file:line z grep wyniku. Czytaj kontekst
   przed wnioskowaniem.
4. **`memphis_chain_query`** — szukaj operator's history w tym obszarze.
   Może bug już discutowany, decision recorded.
5. **`memphis_recall`** — semantic, dla "czy operator kiedyś prosił o X".
6. **DOPIERO TERAZ** propose action lub final claim. Skok (1) → (6) bez
   weryfikacji = confab generator.

**Edge case — gdy tool blocked / sandboxed:**
- Sandbox blokuje? → `memphis_exec` (tier-2) z absolute path
- Surface tier blocks recall? → `/tier 3 <pass>` request od operatora
- Web fetch blocked? → `memphis_brave_search` zamiast direct fetch

---

## Co zapisane gdzie

- **`~/.memphis/config/soul-memory.json:self.learnings`** — 9 nowych
  patterns dodanych 2026-05-10. Bot ładuje to na każdej sesji jako soul
  state. Edit: bezpośredni file write (omija schema).
- **`~/memphis/docs/dev/agent-operational-patterns-2026-05-10.md`** —
  ten plik. Bot odczyta przez `memphis_code_read` (sandbox OK, jest w
  `~/memphis/`).
- **chains journal** — TODO: dodać block przez `memphis_journal` po
  weryfikacji że schema accepts długi content. Bot recall przez
  `memphis_recall` znajdzie po session restart.

---

## Co dalej (operator decision)

Patterns 6 (soul schema), 9 (cascade tracing), 10 (MiniMax overflow) to
**code-side TODOs**. Plan przemyślany przez operatora ("potem zakodujemy").

Patterns 1-5, 7-8 to **bot-side discipline** — soul learnings to
przeczyta i powinien się stosować. Phase 2 anti-confab audyt dalej
będzie łapał gdyby bot drift'ował z powrotem.
