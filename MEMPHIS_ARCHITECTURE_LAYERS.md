# Memphis — narada przed wyruszeniem

> Warstwowa mapa systemu. Punkt wyjścia dla długiej kampanii.
> Pisane 2026-04-18 po PR #146 merged, kiedy fundament jest zielony
> (33 fixy, 2054 testy, 0 audytu).
> Komplementarne do `ROADMAP_FOR_SORT_BRANCHES.md` — tamto mówi **co
> robimy po kolei**, to mówi **gdzie w systemie to żyje**.

---

## Dlaczego warstwy, nie fazy

Mieliśmy plan fazowy: P → L → T → G → Agora. Sensowny jako **harmonogram**,
ale nie odpowiada na strategiczne pytanie: **gdy dodajemy nowe Skill, nowe
Tool, nowe Command — jak sprawić, żeby pojawiły się we wszystkich surface'ach
od razu?** GUI, TUI, Telegram, własna aptka, MCP dla zewnętrznego LLM — każdy
z nich powinien je widzieć, bez ręcznego wpisywania w 5 miejscach.

Odpowiedź: **strict layered architecture + declarative registries**. Raz
zarejestruj na odpowiedniej warstwie, każdy surface się sam dopasuje.

Ten dokument to narada przed kampanią. Nie gwarantuje zwycięstwa, ale gwarantuje,
że nie pogubimy się w terenie.

---

## Teren — stan na 2026-04-18

| Co mamy zielone                    | Co puste, co trzeba dobudować                           |
| ---------------------------------- | ------------------------------------------------------- |
| Identity (DID, ed25519)            | Skill registry                                          |
| Chain storage + multi-chain        | Command registry                                        |
| Vault 2FA + recovery               | Blueprint registry (config)                             |
| MCP tool executor + surface policy | Memphis GUI (Tauri)                                     |
| Gateway HTTP + auth                | Agora tier + trust graph                                |
| TUI, web-dashboard, Telegram       | Własna aptka (starter)                                  |
| Sync-manager (private tier)        | Federation mutual auth / revocation / QR                |
| Provider cascade + cost-cap        | Local-LLM CI invariant                                  |
| Circuit breaker + safe mode        | Trust.chain + trusted.chain                             |
| Test suite 2054/2054               | Blueprint codegen (skills/tools/config→GUI+TUI+CLI+MCP) |

Mamy ~70% fundamentu. Brakujące 30% to **rejestry deklaratywne** — to, co
sprawi że system scala się w coś spójnego, nie w luźną kupę modułów.

---

## Siedem warstw

```
╔═══════════════════════════════════════════════════════════════╗
║  L7  EXTERNAL INTEGRATION                                      ║
║      hardware · payment rails · Lightning · MCP clients        ║
╟───────────────────────────────────────────────────────────────╢
║  L6  FEDERATION                                                ║
║      private tier (signed sync) · public tier (Agora)          ║
╟───────────────────────────────────────────────────────────────╢
║  L5  SURFACES                                                  ║
║      TUI · GUI · Telegram · custom HTTP app · MCP server · CLI ║
╟───────────────────────────────────────────────────────────────╢
║  L4  POLICY & AUTHORIZATION                                    ║
║      tiery · autonomy · per-surface policy · audit             ║
╟───────────────────────────────────────────────────────────────╢
║  L3  CAPABILITY REGISTRIES ← tu jest cała magia spójności      ║
║      tools · skills · commands · blueprints (config)           ║
╟───────────────────────────────────────────────────────────────╢
║  L2  RUNTIME SERVICES                                          ║
║      gateway · provider-cascade · memory · sync · scheduler    ║
║      circuit-breaker · cost-cap · safe-mode · metrics          ║
╟───────────────────────────────────────────────────────────────╢
║  L1  STORAGE                                                   ║
║      chains (journal·soul·decisions·trust·trusted·agora.*)    ║
║      vault entries · append-lock · signed-block validation     ║
╟───────────────────────────────────────────────────────────────╢
║  L0  IDENTITY & CRYPTO                                         ║
║      DID · ed25519 · Argon2id KDF · 2FA Q&A · secure compare   ║
╚═══════════════════════════════════════════════════════════════╝
```

Reguła: **warstwa N może wołać N-1, N-2, … 0. Nigdy nie woła N+k.**

Surface (L5) nie sięga do sync-managera (L2) bezpośrednio. Idzie przez
rejestry (L3) i policy (L4). Dlatego można dołożyć nowy surface (np.
Slack bot) bez dotykania L2.

---

## L0 — Identity & Crypto

**Co robi:** prymityw tożsamości i podpisu. Każda sygnaturka w systemie
trafia tutaj, żeby zostać podpisana albo zweryfikowana.

**Co jest (Rust crates — primitive crypto):**

- `crates/memphis-vault/src/did.rs` — DID z ed25519
- `crates/memphis-vault/src/keyring.rs` — Argon2id KDF (64 MB, 3 iter, p=4)
- `crates/memphis-vault/src/two_factor.rs` — Q&A 2FA (po #144 zwraca Result)
- `crates/memphis-vault/src/crypto.rs` + `vault.rs` — vault encryption + persistence
- `crates/memphis-core/src/signature.rs` — sign/verify bloków
- `crates/memphis-core/src/hash.rs` — chain block hashing

**Co jest (TS boundary — 11 plików `src/security/`):**

- `constant-time.ts` — `secureCompare` (line 58, verified 2026-04-19)
- `auth-fail-closed.ts` — fail-closed authentication defaults
- `content-scan.ts` — risk classification dla web-fetched content
- `fail-closed.ts` — generic fail-closed primitives
- `integrity.ts` — file/chain integrity checks
- `request-limits.ts` — request rate/size limits
- `runtime-security-events.ts` — security audit emit
- `tier2-passphrase-file.ts` — operator passphrase storage
- `tier3-session.ts` — time-limited tier-3 elevation
- `unicode-normalizer.ts` — input normalization (anti-homograph)
- `vault-boundary.ts` — vault access boundary

**Kiedy ruszamy tę warstwę:** prawie nigdy. Post-quantum migration w 2028 albo
gdy NIST coś ogłosi. W międzyczasie cisza.

**Interfejs wyżej:** "dostaję bajty, oddaję bajty podpisane". Nic więcej.

---

## L1 — Storage

**Co robi:** append-only chain z block-level signature verification.
Multi-chain support (różne chains dla różnych celów).

**Co jest:**

- `src/infra/storage/chain-adapter.ts` — TS strona
- `src/infra/storage/rust-chain-adapter.ts` — NAPI bridge do Rusta
- `crates/memphis-core/src/chain.rs`, `block.rs`, `hash.rs` — Rust logic
- `withAppendLock` — atomic chain appends
- Vault entries persistence

**Co do dobudowania:**

- `withAppendLockAcrossChains` (Phase T #151) — atomic writes across 2 chains
- nowe chain types: `trust.chain`, `trusted.chain`, `agora.*` (Phase T + Agora)

**Interfejs wyżej:** "daj mi przechowywać i czytać bloki, gwarantuj
sygnaturę, gwarantuj atomowość zapisów".

---

## L2 — Runtime Services

**Co robi:** "co Memphis robi kiedy działa". Usługi bez stanu (poza
własnym), używane przez surface'y pośrednio przez L3/L4.

**Co jest (wszystko sprawdzone w produkcji):**

_Core runtime services (`src/`):_

- Gateway HTTP (`src/gateway/server.ts`) — pojedynczy API surface dla L5
- Provider cascade (`src/providers/`) — local-first, fallback'y
- Memory/recall (`src/memory/`, `src/soul/`)
- Sync-manager (`src/sync/sync-manager.ts`) — signed-block push/pull (12 plików łącznie)
- Decision recording (`src/decision/`) — backend dla `memphis_decide` tool
- Reflection passes (`src/reflection/`) — self-reflection runtime
- Cognitive runtime (`src/cognitive/`) — categorizer + cognitive integration
- Resilience patterns (`src/resilience/`) — retries, fallbacks, degraded paths
- Federation primitives (`src/federation/`) — peer-side state (komplementarne do L6)
- Cache layer (`src/cache/`) — runtime cache
- Agent runtime (`src/agent/`) — agent profiles + execution

_Infra services (`src/infra/`):_

- Scheduler (`runtime/scheduler.ts`)
- Circuit breaker (`runtime/circuit-breaker.ts`) — po #141 Codex-P1 fix
- Cost-cap + budget (`runtime/cost-cap.ts`)
- Safe-mode (`runtime/safe-mode.ts`) — iptables egress filter
- Self-modify + auto-revert (`runtime/self-modify-revert.ts`)
- Self-update install (`self-update/`) — PR #110 GPG-verified install
- Metrics (`logging/metrics.ts`)
- Observability (`observability/`) — OpenTelemetry overlay (PR #112)
- Auth services (`auth/`) — operator-gate PBKDF2
- Embeddings TS-side (`embeddings/`) — koresponduje z `crates/memphis-embed/`
- Feature flags (`features/`) — `MemphisFeatureFlag` enum
- TUI host (`tui-host/`) — Rust TUI ↔ TS runtime bridge

**Co do dobudowania:**

- Peer transport auth (Phase P #148)
- Per-peer rate limiter (Phase P #148)
- QR invite bootstrap (Phase P #148)
- Peer revocation flow (Phase P #148, Phase T #151)
- Local-LLM offline invariant (Phase L #149) — nie nowa usługa, tylko **test**
  egzekwujący, że L2 działa bez L6 federation

**Interfejs wyżej:** gateway HTTP endpoint'y. Każda usługa ma swój route.
Nic bezpośrednio importowanego przez L5.

---

## L3 — Capability Registries ← **tu jest klucz całej spójności**

**Co robi:** **jedyny layer który wie co Memphis UMIE**. Wszystkie surface'y
(L5) tylko czytają tu. Dodajesz tool/skill/command raz, pojawia się
wszędzie.

**Cztery rejestry:**

### a) Tool Registry (MCP tools — już istnieje częściowo)

```ts
interface ToolDescriptor {
  id: 'memphis_fs_write' | 'memphis_exec' | ...;
  title: string;
  description: string;
  schema: z.ZodSchema;            // parameters
  tier: 1 | 2 | 3;                 // min tier required
  surface_allowlist?: Surface[];  // if absent = all
  handler: (input, ctx) => Output;
  llm_guidance: string;            // for LLM reasoning about when to call
}
```

**Co jest:** `src/gateway/tool-registry.ts` + `src/mcp/tools/*` (37 tool files).
Ale **nie jest to pełny declarative registry** — handlers są rozproszone,
schematy są rozproszone (niektóre TypeScript types, niektóre Zod).

**Co do dobudowania:** unifikacja. Każdy tool deklaruje pełny `ToolDescriptor`
w jednym miejscu. Surface'y iterują po tej liście.

### b) Skill Registry (nowy — nie istnieje)

Skills = gotowe workflow'y wielokrokowe, których LLM albo operator może użyć
jako pojedynczej jednostki.

```ts
interface SkillDescriptor {
  id: 'security-review' | 'offline-test' | 'hotfix-bundle' | ...;
  title: string;
  description: string;
  trigger: 'manual' | 'event:*' | 'cron:*';
  steps: Step[];                  // composition of tools + logic
  inputs?: z.ZodSchema;
  tier: 1 | 2 | 3;
  surface_allowlist?: Surface[];
}
```

**Co jest:** ~nic w tym modelu. Mamy `.claude/skills/*` ale to jest Claude
Code convention, nie Memphis convention. Memphis TUI, GUI, Telegram, własna
aptka powinny móc wywołać tę samą `security-review` skillę.

**Co do dobudowania:** cały rejestr + runtime executor.

### c) Command Registry (operator commands — częściowo istnieje w CLI)

Commands = jawne operator actions. `memphis vault init`, `memphis trust pin`,
`memphis backup restore`.

```ts
interface CommandDescriptor {
  id: 'trust.pin' | 'vault.rotate' | ...;
  title: string;
  description: string;
  argspec: z.ZodSchema;
  auth_required: 'operator' | 'vault' | 'tier3';
  destructive: boolean;
  handler: (args, ctx) => Result;
}
```

**Co jest:** CLI commands w `src/infra/cli/commands/*` ale **nie ma jednego
deklaratywnego rejestru**. TUI, Telegram nie widzą ich automatycznie.

**Co do dobudowania:** jednolity rejestr. CLI command handlery zostają ale
rejestrują się w `CommandRegistry`. TUI/GUI/Telegram iterują po rejestrze
i generują swoje interfejsy.

### d) Blueprint Registry (config options — nie istnieje)

Blueprints = każda konfigurowalna opcja (tier thresholds, cooldowns, stake
amounts, attestation TTL, peer-rate-limits, ...). Deklaratywna.

```ts
interface Blueprint<S extends z.ZodTypeAny> {
  id: 'attestation-ttl' | 'breaker-failures' | ...;
  title: string;
  schema: S;
  defaults: z.infer<S>;
  category: 'security' | 'trust' | 'agora' | ...;
  llm_guidance: string;
}
```

**Co jest:** ~40 env-var-ów rozsianych po kodzie.

**Co do dobudowania:** Blueprint system (Phase B #150 — **defer until pain
is acute** per brutal-truth review).

### Dlaczego te cztery razem

Wspólna właściwość: **każdy ma schema opisujący wejście i metadata opisujący
semantykę**. Surface konsumuje schema → generuje formularz / prompt /
keyboard-button / MCP-tool-json. **Zero duplikacji per-surface.**

To jest też miejsce w którym Blueprint-codegen-pattern ma realny sens.
Dla config'u (~40 opcji) YAGNI; dla unified tools+skills+commands+config
pattern staje się nieodzowny, bo skala i heterogeniczność surface'ów tego
wymaga.

---

## L4 — Policy & Authorization

**Co robi:** "kto może co zrobić, gdzie, widocznie". Bramkuje L3 przed
L5.

**Co jest:**

- Tier system (tier-1, tier-2, tier-3) — `src/security/tier3-session.ts`
- Autonomy modes (restricted, balanced, full) — env-var driven
- Exec policy (`src/gateway/exec-policy.ts`) — allowlist/blocklist commands
- Surface policy (`src/gateway/surface-policy.ts`) — per-surface tool allowlist
- Operator gate (`src/infra/auth/operator-gate.ts`) — PBKDF2 passphrase
- Prompt boundary (`src/gateway/prompt-boundary.ts`) — risk classification
- Security audit (`src/infra/logging/security-audit.ts`)

**Co do dobudowania:**

- Rozszerzenie surface-policy żeby obejmowało także skills + commands
  (obecnie obejmuje tylko tools)
- Policy evaluator nad rejestrami L3: `canUseOnSurface(capability, surface,
tier, autonomy) -> allow | deny | elevate-required`

**Interfejs wyżej:** "czy mogę użyć tego capability z tego surface'u w
obecnym tier'ze?". Idempotentne, pure, observable (audit-log).

---

## L5 — Surfaces

**Co robi:** "jak operator lub zewnętrzny wołacz interaktuje z Memphis".
Każdy surface = deklaratywny konsument L3 + L4.

**Co jest (główne surface'y):**

- **TUI** — `crates/memphis-tui/` — pełny ratatui dashboard
- **Web dashboard** — `src/dashboard/web-dashboard.ts` — z auth token po #143 + XSS-escape po #138
- **Telegram bot** — `src/infra/cli/handlers/telegram.handler.ts`
- **CLI** — `src/infra/cli/commands/*` + `bin/memphis.js`
- **MCP server** (dla zewnętrznego LLM) — `src/mcp/transport/http.ts` +
  `src/bridges/mcp-native-transport.ts` (loopback-fail-closed po #139)
- **Gateway HTTP** — `src/gateway/server.ts` (API dla custom app'ek)

**Adaptery / wewnętrzne komponenty surface'ów (NIE same surface'y):**

- `src/bridges/` — bridges między surface'ami (np. MCP-native bridge)
- `src/app/` — app-level entry points
- `src/gateway/voice/` — voice surface adapter (audio in/out)
- `src/gateway/channels/` — multi-channel routing

**Co do dobudowania:**

- **Memphis GUI** (Tauri) — Phase G #152 — szósty surface, ale **najważniejszy**
  dla docelowego UX
- **Starter custom app** — zupełnie basic HTTP client (Python script? React
  toy?) demonstrujący że gateway HTTP API jest self-contained. Nie jako
  dedykowany phase — jako **sample repo** / docs example.

**Reguła surface'u:** nie wolno mu zawierać logiki biznesowej. Wszystko
wyciągać z L3 przez L4 gate. Surface jest **renderer'em** stanu +
**wywoływaczem** capability przez gateway.

---

## L6 — Federation

**Co robi:** jak instancje Memphis rozmawiają między sobą.

**Co jest:**

- **Private tier** — sync-manager w L2, + signature gate po #142, + peer
  allowlist via `MEMPHIS_SYNC_PEERS`
- **Trust chains** — w L1, pin/revoke via operator sign

**Co do dobudowania:**

- Phase P #148 — mutual auth, revocation, rate limits, QR bootstrap
- Phase T #151 — trust.chain + trusted.chain dual-write
- Phase 0-5 — public tier (Agora: attestations + stake + reviews + discovery
  - marketplace)

**Interfejs wyżej:** sync-manager i attestation engine wystawione jako
internal API do L2 i dalej przez gateway.

---

## L7 — External Integration

**Co robi:** mosty do świata poza Memphisem.

**Co jest (częściowo):**

- MCP client dla zewnętrznych LLMów (outbound) — `src/providers/*`
- Telegram adapter — ale to jest **surface** (L5), nie external — Telegram
  użytkownik interaktuje przez Telegram, Memphis działa po swojej stronie
- memphis-ml HAL (hardware backends) — `crates/memphis-ml/ml-hw-*` —
  osobny repo, kandydat na integrację w Phase 3b

**Co do dobudowania (deferred):**

- Payment adapters (Lightning, Monero, wallet-in-vault) — Phase 3c #156
- ML-as-contract-language — Phase 3b #156
- Future: dodatkowe MCP clients, model APIs

---

## Crates Rust — kompletny inwentarz (7 crates)

| Crate                | Pliki                                                            | Rola                                                                                      | Warstwa     |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| `memphis-core`       | `chain.rs`, `block.rs`, `hash.rs`, `signature.rs`                | Chain logic, block hashing, signature verify                                              | L0 + L1     |
| `memphis-vault`      | `did.rs`, `keyring.rs`, `crypto.rs`, `vault.rs`, `two_factor.rs` | DID, Argon2id KDF, vault encryption, Q&A 2FA                                              | L0          |
| `memphis-embed`      | `cache.rs`, `chain_integration.rs`, `pipeline.rs`, `store.rs`    | Embedding pipeline + cache + chain integration. **Central dla M6** sovereign-RAG cascade. | L1 + L2     |
| `memphis-napi`       | bindings                                                         | TS↔Rust bridge, exposes core/vault/embed do TS surface'ów                                 | L2 (bridge) |
| `memphis-operator`   | `chat.rs`, `config.rs`, `provider.rs`, `runtime.rs`              | Rust operator console (replaces TS TUI per ROADMAP-CURRENT.md M1)                         | L5          |
| `memphis-tui`        | full ratatui app                                                 | Active native TUI dashboard                                                               | L5          |
| `memphis-case-index` | `lib.rs` (szkielet)                                              | Chain indexing dla `memphis_case_query` tool                                              | L1          |

**Out-of-tree:** `memphis-ml` (osobny repo `Memphis-Chains/memphis-ml`) — kandydat na Agora contract language (Phase 3b, conditional na Phase 3-spike #160).

## Kluczowa inwariantka: "add once, seen everywhere"

```
Dodaję nowy tool / skill / command / config:

  1. piszę TypeScript descriptor:
       export const myCapability: ToolDescriptor = { ... };

  2. rejestruję na starcie runtime:
       toolRegistry.register(myCapability);

  3. surface'y widzą automatycznie:
       — TUI:       nowy item w catalog view
       — GUI:       nowy przycisk + form w Tools panel
       — Telegram:  /mycapability command
       — CLI:       memphis capability invoke <args>
       — MCP:       wystawiane jako MCP tool dla external LLM
       — custom app: dostępne via gateway HTTP /v1/tools/:id/invoke
```

Warunki by to działało w praktyce:

1. **Każdy surface czyta z rejestrów, nie z plików w src/mcp/tools/.**
2. **Każdy descriptor ma pełną Zod schema na inputy.** Zero free-form
   parsingu w surface'ach.
3. **Gateway ma jeden endpoint**: `POST /v1/capability/:kind/:id/invoke`
   z uniform body-shape. Wszystkie surface'y wołają ten endpoint.
4. **Policy (L4) decyduje raz**, w gateway. Surface nie ma logiki "czy ten
   tier tu się nadaje".

Ten wzorzec = **1 tydzień prac w L3** + **1 tydzień w L5 migracji**.
Koszt jednorazowy. Zwrot przez kolejne N lat każdej featurowej pracy.

---

## Mapa kampanii → warstwy

Każde GitHub issue (#148–#158) mapuję na warstwy które zmienia.

| Kampania                              | L0  | L1  | L2  |  L3   | L4  |  L5   |    L6    | L7  |
| ------------------------------------- | :-: | :-: | :-: | :---: | :-: | :---: | :------: | :-: |
| #148 Phase P — private tier hardening |     |     |  ✓  |       |  ✓  |       |    ✓     |     |
| #149 Phase L — offline invariant test |     |     |     |       |     |       |          |     |
| #151 Phase T — trust chains           |     |  ✓  |  ✓  | ✓ cmd |  ✓  | ✓ cli |    ✓     |     |
| #150 Phase B — Blueprint system       |     |     |     | ✓ cfg |     | ✓ all |          |     |
| #152 Phase G — Tauri GUI              |     |     |     |       |     | ✓ GUI |          |     |
| #153 Phase 0 — Agora design           |     |     |     |       |     |       | ✓ design |     |
| #154 Phase 1 — attestations           |     |  ✓  |  ✓  | ✓ cmd |  ✓  |       |    ✓     |     |
| #155 Phase 2 — reviews                |     |  ✓  |  ✓  |       |     |       |    ✓     |     |
| #156 Phase 3 — stake + ML + pay       |     |  ✓  |  ✓  |       |  ✓  |       |    ✓     |  ✓  |
| #157 Phase 4 — discovery              |     |     |  ✓  |       |     |       |    ✓     |     |
| #158 Phase 5 — marketplace UX         |     |     |     |       |     | ✓ GUI |          |     |

**Obserwacja:**

- Phase P, T, 1 wielowarstwowe — pracochłonne
- Phase L, 0 jedno/zero-warstwowe — małe, tanie wygrane
- Phase G, 5 tylko L5 — widoczne, ale niedotykają fundamentu
- Phase B (jeśli kiedyś) — unified L3 refactor + surface migration

---

## Reguły warstw (discipline)

Łamanie tych = długotermnie plącze architekturę.

**R1.** Warstwa N może wołać N-1, …, 0. Nigdy N+k.

**R2.** L5 surface **nie trzyma stanu aplikacji**. Stan jest w L1 (chains)
albo L2 (runtime). Surface jest reactive renderer'em.

**R3.** L3 descriptor'y są **deklaratywne**. Jeden plik = cała informacja o
capability. Żadnych "dodatkowych miejsc" gdzie trzeba wpisać duplikat.

**R4.** L4 policy evaluator jest **czystą funkcją**. Idempotent, observable,
testable. Nie sięga do L1/L2 bezpośrednio.

**R5.** Każdy nowy `MEMPHIS_*` env var MUSI mieć Blueprint w L3 (po Phase B).
Do tego czasu: env var + komentarz, ale świadomie wiedząc że to dług.

**R6.** Każda operator-initiated zmiana stanu → block w odpowiedniej chain.
Chain audit discipline z poprzednich PR-ów (#127, #141, #146).

**R7.** Każda decyzja finansowa (stake, payment, wallet-unlock) → vault-2FA
modal. Pattern z "Interactive secret input required" memory.

**R8.** Local-LLM fallback jest unconditional (Phase L CI gate). Żadne PR
nie łamie offline-invariant.

---

## Order of march (realistyczny, two-horizon)

### Horizon 1 — fundament jeszcze cięższy (2-3 tygodnie)

Cel: zbudować L3 capability registries **ZANIM** dodamy GUI albo Agorę.
Bez tego zbudujemy GUI jako bespoke wiring, potem refaktor.

1. **Week 1 — Phase L + Phase P pierwsza tranza** (~4 dni)
   - #149 offline invariant (pół dnia)
   - #148a `enforcePeerTransportAuth` + peer revocation flow
2. **Week 1-2 — L3 Capability Registry MVP** (nowe, nie w roadmapie jako
   phase)
   - Unified `ToolRegistry` — migrate 5 existing MCP tools as pilot
   - `SkillRegistry` shell (pusty na start, ale infrastructure jest)
   - `CommandRegistry` shell
   - Surface migration: TUI czyta z nowego rejestru (proof że pattern
     działa)
3. **Week 2-3 — Phase P tranza 2 + Phase T** (~1 tydzień)
   - #148b rate limiter + QR bootstrap
   - #151 trust.chain + trusted.chain

**Ship v1.4.0** — "Private tier hermetyczne + capability registry foundation".

### Horizon 2 — minimalny GUI jako konsument rejestrów (3-4 tygodnie)

4. **Phase G minimal** (#152)
   - Tauri skeleton
   - Chat view (streaming + approval inline)
   - **Settings view czyta BLUEPRINTS z rejestru** (jeśli Phase B zrobiona,
     jeśli nie — hand-written forms z dług do Phase B)
   - **Tools panel czyta z ToolRegistry** — demonstracja że pattern działa
   - Status bar
5. **Starter custom app** — bardzo prosty, jako docs example:
   Python 50-line script albo `apps/examples/basic-client/` —
   pokazuje jak external code używa gateway HTTP API
6. **Ship v1.5.0 preview** — 5-10 users na miesiąc

### Decision gate → Horizon 3 (conditional)

Dopiero tu patrzymy na feedback i decydujemy czy robić Agorę (Phases 0-5).

---

## Pierwsze expeditions (sprint startowy w następnych dniach)

Konkretnie, w tej kolejności:

1. **Phase L #149** — offline invariant test. Pół dnia. Blocking na nic.
   **Zaczynamy tu. Małe, mierzalne, bezwzględnie zielone.**

2. **Capability Registry foundation** — zanim Phase G dotknie L5, ustawiamy
   L3 jako 1st-class. Migrujemy istniejące MCP tools do jednolitego
   descriptor format. To ~3 dni pracy ale odbędzie się tylko raz.

3. **Phase P #148 stacked PRs** — mutual auth + revocation + rate limits +
   QR. Każdy jako osobna PR-ka z 7-sekcyjną Function Evaluation.

4. **Phase T #151** — trust chains. Po Phase P, bo używa revocation z Phase P.

5. **Pause, ship v1.4.0, pisujemy retrospective.**

---

## Sygnały — jak poznamy że każda kampania wyszła

**Phase L success:** `npm run test:offline` zielone lokalnie, CI gate
egzekwuje na każdym PR-ze. Każdy dev pozbawiony internetu i zewnętrznych
providerów dalej ma działającą chat-interakcję.

**Capability Registry success:** dodając nowy tool (np. `memphis_weather_get`)
pojawia się automatycznie w TUI catalog, w GUI Tools panel (gdy Phase G),
w MCP server dla external LLM, w Telegram jako `/weather_get` bez
dodatkowego kodu per surface. **Jeden descriptor → pięć miejsc.**

**Phase P success:** dwa ephemeral Memphis instances parują się QR-kodem w
pod-minuty, wymieniają sygnowany block, widzą siebie w `memphis trust
list`, po revoke peer B traci możliwość push/pull do A w następnym cyklu
sync.

**Phase T success:** `memphis trust pin X`, potem `memphis trust revoke X`.
`memphis trust list` pokazuje puste. `memphis trust history X` pokazuje
wpis pin + wpis closed. Audit complete, niemożliwe do "wyzerowania".

**Phase G success:** `.deb` instaluje się na świeżym Ubuntu 24.04, GUI
startuje, chat streamuje, tool approval działa inline. Pięciu testerów
pisze "działa, ale chciałbym X" — i X jest feedbackem który kieruje
Horizon 3.

---

## Zamykam

Mapa jest. Reguły są. Teren znam.

Następny krok: wracam do issue #149 (Phase L), bo jest najmniejszy i
**zaraz zaczynamy**.

Wracamy do kodu. Kończę naradę.
