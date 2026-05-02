# Sprint pre-plan: TUI full-mode + agent self-awareness

> **STATUS 2026-05-02**: pre-plan delivered. TUI `/tier 0/1/2` dispatch landed in Sprint S2 (`crates/memphis-tui/src/app.rs:4339-4340`, post 2026-04-26). `/mode A|B|C|D|E` already in `app.rs:325-326`. **Do not cite this file as live "what's missing in TUI" in future audits.** TUI feature parity with Telegram for the tier ladder is achieved as of v1.8.0.

---

**Author:** Claude (deep search 2026-04-26)
**Status:** Pre-plan — operator review przed `/plan`
**Triggered by:** dzisiejsza sesja TUI/Telegram. Operator zauważył:
- Bot LLM mówi *"tier 3 — zablokowane, nie mam takich narzędzi"* (already fixed PR #281)
- TUI Rust nie obsługuje `/tier 0/1/2`, tylko `/tier 3 <pass>`, `/tier status`, `/tier revoke`
- Bot nie wie o całym capability surface od startu
- Logi TUI: *"unsupported command: `/tier 2 xep624624xep&A`. This Rust TUI only runs native or host-backed commands by default. ... rerun it as /legacy tier 2 xep624624xep&A"*

---

## Część 1 — TUI full-mode refactor

### Stan obecny (z deep-search)

**Architektura:** dwa procesy, dwa języki.
- `crates/memphis-tui/` (Rust, **8009 LoC**, ratatui-based) — UI loop, slash commands, status bar, widgets
- `src/infra/tui-host/` (TypeScript, **1135 LoC**) — extension host backing native TUI commands przez NDJSON RPC

**Slash command dispatch w Rust TUI** (`app.rs`):
- *Native commands* — handled w Rust (np. `/help`, `/tier`, `/journal`, `/recall`)
- *Host-backed commands* — Rust → IPC do TS host przez `ExtensionHostCommand{ label, command, args }` (`security.tier.elevate`, `security.tier.status`, etc.)
- *Legacy fallback* — `/legacy <cli args>` runs `memphis --json <args>` jako one-shot subprocess
- *Unknown commands* → `unsupported_tui_command_notice` (linia 4242-4250) z hint do `/legacy`

**Tier slash handler** (`app.rs:4159-4194`):
```rust
// Obsługiwane:
//   /tier              → security.tier.status
//   /tier status       → security.tier.status
//   /tier revoke       → security.tier.revoke
//   /tier 3 <pass>     → security.tier.elevate {tier:3, passphrase}
// NIE obsługiwane:
//   /tier 0|1|2 ...    → fallthrough do _ => Ok(None) → "unsupported"
```

**Gdzie tier 0/1/2 IST obsługiwane:** w **Telegram** (`src/gateway/channels/telegram.ts:170-200`) — full `/tier <0|1|2|3>` handler z TTL 15min na non-default tiers.

### Asymetria

| Surface | `/tier 0` | `/tier 1` | `/tier 2` | `/tier 3 <pass>` | `/tier status` | `/tier revoke` |
|---|---|---|---|---|---|---|
| **Telegram** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **TUI** | ❌ "unsupported" | ❌ | ❌ | ✅ | ✅ | ✅ |
| **CLI** | n/a (separate process) | n/a | n/a | n/a | ⏳ shipping #282 | ❌ |

### Inne brakujące rzeczy w TUI

W deep-search znalazłem (przed-decyzyjnie):

1. **Cognitive mode switching** (`/mode A|B|C|D|E`) — Rust TUI status bar pokazuje `[Mode:B]` ale **nie ma slash command** aby zmienić. LLM potencjalnie może wywołać tool `memphis_cognitive_mode_set` (tier 2)... ale ten tool **NIE MA handlera** (sprawdź sekcję 2 poniżej).

2. **Full slash help discovery** — `/help` istnieje, ale trudno znaleźć "wszystkie slash commands". Surface vs CLI vs MCP commands rozłożone w wielu miejscach.

3. **Restart / config reload** — `/legacy restart` działa ale wymaga full CLI roundtrip. Native slash mógłby być szybszy.

4. **Status bar info elevation** — pokazuje `Mode:B · ctx:32k · tok~ · ready · PULSE:healthy · session:...`, ale NIE pokazuje tier elevation status (tier 3 active? gdy/expires?).

5. **Tools listing** — operator nie ma sposobu wyświetlić `co bot może zrobić` w TUI. Tylko `/help` o slash commands, nie o LLM toolach.

### Proponowany scope refactoringu (do plan mode)

**Faza A: Symmetry — TUI dorównuje Telegramowi (1-2 dni):**
- A1. `/tier 0`, `/tier 1`, `/tier 2` w Rust TUI (linia 4194 fallthrough → dodać arms)
- A2. Każdy non-3 tier → host command `security.tier.set` (need TS handler) → `clearSessionAuth` + reset env override
- A3. Status bar tile dla aktywnego tier 3 (countdown)

**Faza B: Cognitive mode parity (0.5 dnia):**
- B1. `/mode A|B|C|D|E` slash w Rust TUI → host command `cognitive.mode.set`
- B2. TS handler in `src/infra/tui-host/commands.ts` dispatching to cognitive engine
- B3. Wymaga ŻEBY tool `memphis_cognitive_mode_set` faktycznie istniał (zob. Część 2 — to jest **blocker**)

**Faza C: Self-awareness in TUI (1 dzień):**
- C1. `/tools` slash command — pokazuje aktywny `availableTools` list z tierem każdego
- C2. `/skills` slash — already exists in CLI, port to TUI
- C3. `/cognitive` slash — pokazuje aktualny mode + opisy A-E
- C4. `/surface` slash — pokazuje surface policy (maxToolTier, allow flags)

**Faza D: Status bar enhancement (0.5 dnia):**
- D1. Pokaż tier 3 active/inactive + remaining time
- D2. Pokaż czy /tier elevation jest "useful" (czy są tier-2/3 toolsy faktycznie dostępne)
- D3. Expand mode info — `[Mode:B (Inferred Decisions)]` zamiast tylko `[Mode:B]`

**Faza E: Help unification (0.5 dnia):**
- E1. `/help slash` — wszystkie slash commands grouped by category
- E2. `/help tools` — co LLM może wywołać w obecnej sesji
- E3. `/help cli` — referencja do `memphis --help` i `/legacy`

**Total estimate:** 3-4 dni solo-dev.

### Ścieżki kodu do dotknięcia

Rust:
- `crates/memphis-tui/src/app.rs` — slash dispatch (linia ~4100-4200), command handlers, status bar (linia ~600-900 ui rendering), help text (linia ~1440-1450)
- `crates/memphis-tui/src/ui.rs` (385 LoC) — main render loop

TypeScript host:
- `src/infra/tui-host/commands.ts` — host command dispatch table; nowe handlery dla `security.tier.set`, `cognitive.mode.set`
- `src/infra/tui-host/protocol.ts` — extend `ExtensionHostCommand` if needed (probably not — `args: json!{}` is generic)

### Risks

- Rust TUI is **8009 LoC in one file** (`app.rs`). Każda zmiana powiększa technical debt. **Sugerowane**: refactor wziąć jako okazję na rozdrobnienie (slash module, status module). Ale to scope creep.
- Niektóre native commands kolidują z `memphis <command>` CLI. Spójność potrzebna — slash commands muszą mówić "this is TUI-only" jeśli różnią się od CLI.
- Wymagane testy — dziś `app.rs` ma testy (`#[cfg(test)] mod tests`) na slash parsing (linia ~5350+), ale nie pełen integration test.

---

## Część 2 — Memphis agent self-awareness

### Stan obecny

**Tool registry** (`src/gateway/tool-registry.ts`) ma **37 toolsów** z metadanymi (name, tier, capabilities, description, optional inputSchema, optional featureFlag).

**Tool executor** (`src/gateway/tool-executor.ts:1097`) — `createInProcessToolExecutor` buduje runtime tools przez `createRuntimeTools(deps)` (linia 157). To zwraca `RuntimeToolDefinition[]` z handlerami `execute`.

**`listTools()`** (linia 1100) — filtruje przez `isEnabled()` = `upstreamEnabled() && isToolEnabledByFeatureFlag(tool.name)`.

**Surface policy filter** (`src/gateway/turn-runtime.ts:313-320`) — `constrainToolExecutorToSurface` filtruje przez `isToolAllowedForSurface(tool, policy)` = `meta.tier <= policy.maxToolTier`.

**System prompt** (`src/gateway/system-prompt.ts`) — bierze `availableTools: string[]` (lista NAZW) z calling code, renderuje per-tool blok przez hand-authored `<tool>...</tool>` lub `autoGenToolDoc` (linia 173).

### Krytyczne luki

#### Luka 1: 7 toolsów w registry NIE MAJĄ handlera w executor

Diff between registry and executor (sprawdzone deep-search):

```
W registry, NIE w executor (LLM nie może ich wywołać, ale widzi w nazwach):
  memphis_cognitive_mode_set    (tier 2) ← KLUCZOWY dla switching cognitive mode
  memphis_config_reload          (tier 2)
  memphis_config_set             (tier 2)
  memphis_config_show            (tier 0)
  memphis_loop_step              (tier 2)
  memphis_presence               (tier 0)
  memphis_restart                (tier 2)
```

**Skutek:** LLM widzi `cognitive_mode_set` w docs, próbuje wywołać, dostaje `tool not found` lub similar. Operator obserwuje "bot mówi że nie ma takich narzędzi" — częściowo to dlatego.

**Status:** wymaga 7 nowych runtime handlerów w `tool-executor.ts` lub zastosowanie `executeTool` dispatch do innych modułów (config handler, presence broadcaster, etc.).

#### Luka 2: Tier-2 tools nie są domyślnie dostępne LLM-owi w TUI/Telegram

Surface policy default `maxToolTier: 2` dla TUI i Telegram. **Powinno** odsłaniać tier 0+1+2 (~33 tools). Ale operator's observation:

> Dostępne mi toolsy: memphis_journal, memphis_recall, memphis_search, memphis_decide, memphis_health, memphis_repair, memphis_soul_read, memphis_soul_write — wszystkie tier 0

Tylko 8 tier-0 toolsów. Pozostałych ~25 tier-2 brak.

**Hipoteza:** caller `buildAgentSystemPrompt({availableTools: ...})` nie przekazuje pełnej listy. Może filtruje wcześniej, albo lista jest hard-coded gdzie indziej (np. provider-specific filter for minimax model).

**Trzeba zweryfikować** w plan mode: czy `normalizedToolExecutor.listTools()` (linia 788 turn-runtime.ts) faktycznie zwraca 33 toolsy gdy surface policy maxToolTier=2.

#### Luka 3: System prompt nie agreguje całej capability surface od startu

System prompt (po PR #281 merge) ma `<tier_system>` block, ale **nie ma** `<capabilities>` block z explicit listą:

```
- Co mogę zrobić jako Memphis Agent z aktualnym tierem
- Jakie surface policy jest aktywne
- Co mogę zaproponować operatorowi (slash commands w TUI, /tier elevation)
- Jakie tool gaps istnieją (np. "memphis_cognitive_mode_set is registered but not yet wired")
```

Bez tego LLM **odpowiada z niepewnością** — zobacz operator's TUI snippet:
> "mam ograniczony dostęp (tier 0), więc bez TUI/passphrase nie mogę modyfikować plików ani kodu."

To częściowo prawda (tier 0 = read), ale operator JEST w TUI z tier 3 active. LLM nie *czyta swojego stanu*.

#### Luka 4: Brak `memphis_self_describe` tool

Bot nie może na żądanie przedstawić listy swoich narzędzi z opisami. `memphis_health` (tier 0) zwraca runtime status, ale nie pełen tool inventory.

**Proponowany tool:** `memphis_self_describe` (tier 0, read-only) — zwraca:
- aktualny surface
- aktualny tier (z elevation status)
- aktualny cognitive mode
- pełną listę `availableTools` z tierem i opisem
- listę feature flags enabled
- listę tier-3 sessions (wszystkie surfaces)

Bot wywoła go gdy operator pyta "co umiesz" zamiast halucynować z out-of-date training data.

### Proponowany scope refactoringu (do plan mode)

**Faza A: Wire missing tools (1-2 dni):**
- A1. `memphis_cognitive_mode_set` handler w tool-executor → wywoła `setCognitiveMode(mode)` w cognitive engine
- A2. `memphis_config_show` (read-only redacted view; reuse logic z `/v1/ops/config/show`)
- A3. `memphis_config_set` + `memphis_config_reload` (write — wymaga tier 2 + audit; reuse `setDotEnvValues` + `performHotReload`)
- A4. `memphis_restart` — graceful self-restart (wymaga operator passphrase per existing pattern w restart.ts)
- A5. `memphis_presence` — broadcast presence event (hook do federation peer storage)
- A6. `memphis_loop_step` — debug single-step in cognitive loop engine

**Faza B: Verify tier-2 surface flow (0.5 dnia):**
- B1. Add integration test: surface=telegram, maxToolTier=2 → `availableTools` ma ~33 names
- B2. Find regression: dlaczego operator obserwował tylko 8. Może w starym build bez fix #281, albo prov-specific filter w minimax adapter

**Faza C: Self-describe tool (1 dzień):**
- C1. Add `memphis_self_describe` to registry (tier 0)
- C2. Handler returns structured snapshot: surface, tier, mode, tools, flags, tier3-sessions
- C3. Tests: assert returns include real registered tools

**Faza D: System prompt enrichment (0.5 dnia):**
- D1. Add `<capabilities>` block to system-prompt z structured info (current surface/tier/mode)
- D2. Add `<known_gaps>` block — listing tools-not-yet-wired (so LLM nie kłamie że są dostępne)
- D3. Tests: assert gaps disappear gdy Faza A się skończy

**Faza E: Operator-facing CLI (0.5 dnia):**
- E1. `memphis tools list [--tier 0|1|2|3] [--surface telegram|tui]` — CLI command exposing same data
- E2. `memphis tools describe <name>` — single tool deep dive
- E3. Reuse `memphis_self_describe` data via HTTP endpoint similar to PR #282 pattern

**Total estimate:** 4-5 dni solo-dev.

### Ścieżki kodu do dotknięcia

- `src/gateway/tool-executor.ts:157` `createRuntimeTools` — add 7 missing handlers
- `src/gateway/tool-registry.ts` — add `memphis_self_describe` entry (tier 0)
- `src/gateway/system-prompt.ts` — add `<capabilities>` + `<known_gaps>` blocks
- `src/cognitive/modes.ts` + new helper `setCognitiveMode(mode)` if not exists
- `src/infra/cli/handlers/` — new `tools.handler.ts` for `memphis tools list/describe`
- `src/infra/http/server.ts` — new `GET /v1/ops/capabilities` endpoint (auth-token gated, mirror PR #282)

### Risks

- **Tool registration audit cascade** — niektóre toolsy mogą wymagać operator-passphrase per call (tier 2 tools z security gate). Trzeba sprawdzić czy `memphis_cognitive_mode_set` ma pre-existing gate logic gdzieś.
- **`memphis_self_describe` data privacy** — pokazując pełny tool inventory + flags, ujawnia capability ankietę. Dla tier-0 to OK; trzeba zdecydować czy redact featureFlag visibility.
- **System prompt token budget** — `<capabilities>` block + `<known_gaps>` to ~30-50 tokenów. Niski koszt; warto sprawdzić token tests.
- **TUI commands re-instalacja** — operator ostrzegł że może re-install Memphisa lokalnie (świeży install z merge'em wszystkich PRów); plan musi tolerować zarówno świeży install jak i live upgrade z aktualnego state.

---

## Wspólne ryzyko: re-install lokalny

Operator powiedział: *"możemy przeinstalować i zrobić nową iterację memphis lokalnie — ale to musi robić operator — czyli ja"*. Czyli plan może wymagać:

1. Merge wszystkich pending PRów do main: #279 (vault bulletproof), #280 (MP v0), #281 (system prompt), #282 (tier status)
2. Operator: `memphis reset --runtime --yes` LUB ręcznie wipe `~/.memphis/`, potem `memphis init`
3. Operator: re-add 3 vault entries (minimax/telegram_bot_token/telegram_allowed_user_ids)
4. Plan-mode work landuje na świeżym main z czystym stanem

To upraszcza testowanie (no legacy migration concerns) ale wymaga operatora mid-sprint.

---

## Materiały referencyjne (file:line index)

### Tier system
- `src/security/tier3-session.ts` — sessions Map, request/grant/revoke
- `src/gateway/channels/telegram.ts:113-200` — Telegram /tier full handler
- `crates/memphis-tui/src/app.rs:4159-4194` — TUI /tier partial handler (only 3+status+revoke)
- `src/infra/cli/handlers/tier.handler.ts` — CLI tier status (PR #282)

### Tool surface
- `src/gateway/tool-registry.ts` — 37 tools metadata (single source of truth)
- `src/gateway/tool-executor.ts:1096-1122` — listTools + execute, createInProcessToolExecutor
- `src/gateway/turn-runtime.ts:304-343` — constrainToolExecutorToSurface (tier filter)
- `src/gateway/surface-policy.ts:230-234` — isToolAllowedForSurface

### System prompt
- `src/gateway/system-prompt.ts` — buildSystemPrompt, autoGenToolDoc, renderCognitiveModesBlock
- `src/gateway/agent-runtime.ts:170-187` — buildAgentSystemPrompt caller

### Cognitive modes
- `src/cognitive/modes.ts` — A/B/C/D/E definitions
- `src/cognitive/mode-dispatch.ts` — runtime dispatch by mode

### TUI host RPC
- `src/infra/tui-host/commands.ts:1-891` — TS-side command dispatch
- `src/infra/tui-host/protocol.ts:1-103` — NDJSON protocol shape

---

## Pytania dla operatora przed plan mode

1. **Scope priorytet:** robimy obie części (TUI full-mode + self-awareness) jako jeden duży sprint, czy jako dwa osobne sprinty (TUI najpierw, awareness potem)?
2. **Re-install timing:** kiedy operator chce zrobić reset? Przed sprintem (czysty start), w środku (po Fazie A każdej części), czy na końcu (verify)?
3. **`memphis_self_describe` privacy:** czy redact tool descriptions które ujawniają tier-2 capabilities? Default proposed: **no redaction** (operator-only surfaces).
4. **TUI cognitive mode visibility:** dziś status bar pokazuje `[Mode:B]` (literal). Po Fazie B chcemy `[Mode:B (InferredDecisions)]` — confirm operator preference.
5. **Tool gaps disclosure:** w `<known_gaps>` system-prompt block — czy podawać konkretną listę nie-wired tools, czy tylko "some tier-2 tools are not yet wired; ask operator"?
