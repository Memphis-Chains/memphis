# Memphis — Pełna Mapa Architektury (zweryfikowana 2026-03-27)

**Źródło:** 10 agentów skanowało kod przez ~2 godziny (~850k tokens)
**Pliki:** `memory/memphis-knowledge-synth-2026-03-27.md` (szczegóły)
**Baza:** `life.db` — `memphis_connections` (56 połączeń), `memphis_arch_summary` (67 wpisów)

---

## TL;DR — 3 Tryby Uruchomienia

```
memphis serve          → TS bootstrap + Fastify + opcjonalny Telegram gateway
memphis rust-tui     → Pure Rust TUI cockpit + OperatorRuntime (bez TS)
memphis mcp serve     → Osobny MCP server (14 tools, własne SQLite)
```

---

## Tryb 1: `memphis serve` (główny)

```
memphis serve
  → bin/memphis.js (thin wrapper)
  → src/infra/cli/index.js → runCli()
  → parseCommand() → CliArgs { command: 'serve' }
  → dispatcher.ts → systemCommandHandler → serveCommand()
  → bootstrap()
  
  Bootstrap (16 kroków):
  1. .env check → missingEnv lub kontynuuj
  2. checkRustToolchain() → warn/throw
  3. loadConfig() → AppConfig (Zod schema)
  4. startAlertSuppressionFlushLoop()
  5. runStartupSecurityGuards() → trust root + revocation cache
  6. safeMode enforcement (opcjonalnie)
  7. checkOllama() (jeśli RUST_EMBED_MODE=ollama)
  8. verifyChainIntegrity() → [NAPI: memphis-core chain validation]
  9. ensureSoulManifest() → soul/manifest.json
  10. seedSoulIdentity() (first boot ONLY → 5 journal + 8 case entries)
  11. createAppContainer() → DI: wszystkie repos + providers + orchestration
  12. resumeRecoveredQueueTasksOnStartup()
  13. createHttpServer() → Fastify (35+ routes)
  14. app.listen() → HTTP NASŁUCHUJE
  15. startChannelGateway() → Telegram bot.start() (jeśli enabled)
  16. scheduleReflection() → 5min delay, co 24h

  Wynik:
  ✅ SQLite (migrations run)
  ✅ 10 repositories (session, generation, evolve, dual-approval, tool-approval, etc.)
  ✅ TaskQueue + WAL
  ✅ OrchestrationService + providers (lazy)
  ✅ Fastify HTTP (35+ routes)
  ✅ Telegram gateway (opcjonalne)
  ✅ Rust bridges: chain, vault, embed (przez napi-rs)
  ✅ Reflection engine (scheduled)
```

---

## Tryb 2: `memphis rust-tui`

```
memphis rust-tui
  → dispatcher.ts → interactionCommandHandler → runRustTui()
  → spawn: target/debug/memphis-tui LUB cargo run -p memphis-tui
  → Rust: OperatorRuntime::from_env() (PEŁNY RUST, bez TS)
  → Rust TUI event loop (crossterm)
  
  MemphisClient MA DWA kanały:
  1. DIRECT do OperatorRuntime (Rust→Rust):
     → runtime.chat_stream_with_cancel()
     → runtime.snapshot()
     → runtime.search_semantic/exact()
     → runtime.read_vault_secret()
     → runtime.chat_session()
     → runtime.provider_statuses()
  
  2. TS Extension Host (stdio JSON):
     → spawn: tsx src/infra/cli/index.ts tui host --stdio-json
     → Komendy: telegram.send, doctor.run, agents.list/show/discover,
                  sync.status, apps.list/show/plan, reflect.run, insights.run,
                  config.tools.list/check/pending
     → Events: ready, started, line, result, error, cancelled

  Routing komend TUI:
  - /overview, /memory, /vault → Native (app.rs)
  - /telegram.send, /doctor.run → Host (TS extension)
  - /legacy <cmd> → CLI fallback (node bin/memphis.js)
```

---

## Tryb 3: `memphis mcp serve`

```
memphis mcp serve [--transport stdio|http] [--port n]
  → dispatcher.ts → mcpCommandHandler → createMemphisMcpServer()
  → McpServer (@modelcontextprotocol/sdk v0.3.4)
  → Own SQLite: tool_permissions + tool_call_approvals
  → Own RollbackManager
  → 14 tool handlers registered:
     memphis_journal, memphis_recall, memphis_search,
     memphis_decide, memphis_health, memphis_web_fetch,
     memphis_loop_step, memphis_exec, memphis_case_append,
     memphis_case_query, memphis_soul_read, memphis_soul_write,
     memphis_self_modify
  → server.start()
```

---

## Pełna Mapa Połączeń (56 connections)

### CLI → Runtime
```
bin/memphis.js → dist/infra/cli/index.js → runCli()
  → parser.ts (60+ flags) → dispatcher.ts
    → serve.ts → bootstrap.ts (Fastify + container + gateway)
    → rust-tui.ts → spawn Rust binary
    → mcp.ts → createMemphisMcpServer() (stdio/HTTP)
    → vault handler → vault-boundary.js → NAPI
    → embed handler → NAPI embed operations
    → configure.ts → prompts() → .env / agent profile
```

### Bootstrap → Container (DI)
```
bootstrap.ts
  → createAppContainer(config):
      SQLite (migrations)
      10x Repository (session, generation, evolve, dual-approval, tool-approval, etc.)
      TaskQueue + WAL
      OrchestrationService
      RuntimeProviders (lazy resolved)
```

### HTTP Path (NIE DynamicRouter!)
```
HTTP POST /v1/chat/generate
  → Fastify server.ts → registerChatRoutes()
  → chat.ts handler → orchestration.chat()
  → orchestration.resolveRuntimeProvider() → pickAutoProvider()
  → RuntimeProvider.chat()
  → Provider: OllamaProvider / MinimaxProvider / DeepSeek / GLM
  → HTTP do upstream API

WYNIKI WRACAJĄ:
  → generationEventRepository.create() → SQLite generation_events
  → storeDurableMemory() → chain JSON / embed / FTS5
```

### DynamicRouter ≠ HTTP
```
DynamicRouter (dynamic-router.ts)
  = ODDZIELNE NARZĘDZIE CLI: memphis route
  = NIE jest częścią ścieżki HTTP
  = Używany do TESTOWANIA routingu providerów
```

### Gateway → Chat Loop
```
Telegram/Discord message
  → adapter.start(handler) → handleMessage()
  → 11 kroków:
    1. recall() + fetchUrls() (równolegle)
    2. classifyUserInput() → 6 risk categories
    3. auditInputClassification() → chain
    4. buildRuntimeSystemPrompt() → XML blocks
    5. buildWrappedUserInput() + risk_annotation
    6. buildFetchedContentFragment() (jeśli URL)
    7. sessions.get(chatId) → historia
    8. runAgentLoop() → llm.complete() → tool_calls loop
    9. guardModelOutput()
    10. adapter.send() → Telegram/Discord
    11. sessions.append() + memory.store()

Memory: DWA SYSTEMY:
  - MemoryClient (recall/store per userId) → embed pipeline
  - SessionStore (historia per chatId, max 20 wiadomości)
```

### Tool Executor → MCP → NAPI → Rust Crates

```
Tool Call (np. memphis_recall)
  → MCP Server (withApprovalGate wrapper)
    Tier 0: allow → od razu execute
    Tier 1: api_token → sprawdza token
    Tier 2: require-approval → SQLite pending → czekaj na operator

  Implementacja tool:
  ┌─ Pure TS (NIE NAPI):
  │   memphis_exec → exec.ts → child_process.execSync()
  │   self_modify → self-modify.ts → git snapshot + branch + test
  │   loop_step TS fallback → applyLoopStepTs()
  │
  └─ NAPI → Rust:
      memphis_recall/search → recall.ts → rust-embed-adapter → NAPI
        → memphis-embed (EmbedPipeline: Local lub Ollama HTTP)
      memphis_case_append → case-entry.ts → NAPI case_append
        → memphis-core (Block, CaseEntry) + memphis-case-index (FTS5 SQLite)
      memphis_loop_step → NAPI soul_loop_step
        → memphis-core (LoopState, LoopAction, LoopLimits)
      memphis_journal/decide/health/soul → NAPI chain operations
        → memphis-core (appendBlock, validate, sign)
      vault operations → NAPI vault_init/store/retrieve → memphis-vault
```

### Rust Crate Dependency Graph

```
memphis-core (SAMODZIELNY — wszystkie inne od niego zależą)
  Block, chain, hash, signature, soul, loop_engine, case_entry, harness
  ↓
memphis-vault          ← core (dev only), operator, napi
  XChaCha20-Poly1305 + Argon2id + HKDF v2 2FA
memphis-embed         ← operator, napi (dev only)
  LocalDeterministic (32w) LUB Ollama HTTP (768w) + LRU cache
memphis-case-index    ← operator, napi
  SQLite + denormalized columns + kompozytowe indeksy (NIE FTS5!)
  ↓
memphis-operator (WSZYSTKIE 4 powyższe)
  Chat + chains + vault + memory + security filtering
  + native tools (journal, recall, search, health, soul, case, vault_list)
  ← TYLKO uzywany przez: memphis-tui (direct Rust call)
  ↓
memphis-napi (pusty wrapper — cała logika W operatorze!)
  lib.rs jest pusty → wszystkie #[napi] functions są w memphis-operator
  cdylib wrapper do kompilacji, nie logiki
  ↓
memphis-tui (UŻYWA: operator + stdio JSON TS host)
  7 ekranów: Overview/Chat/Memory/Sessions/Vault/Cases/System
  MemphisClient: direct Rust calls + stdio JSON do TS host
```

---

## Storage — 5 Warstw

```
1. memphis.db (~/memphis/data/)
   better-sqlite3 WAL
   Tables: _meta, sessions, generation_events, approvals,
           dual_approval_requests/events/idempotency,
           tool_permissions, tool_call_approvals (PENDING/APPROVED/DENIED/USED/EXPIRED),
           evolve_sessions, seen_proposals, scheduled_jobs,
           webhook_events, agent_peers,
           memory_search_entries + FTS5

2. case-index.sqlite (~/.memphis/)
   Rust NAPI (memphis-case-index crate)
   NOT FTS5! Denormalized columns + kompozytowe indeksy
   23 pola: case_type, entity, actor, target, instrument, location...
   INSERT OR REPLACE

3. embed/memphis.db (~/.memphis/embed/)
   Embed pipeline + queue + security audit JSONL (1.6MB)

4. chains/ (~/.memphis/chains/) — JSON append-only
   journal/     13 plików
   decisions/   14 plików
   cases/       8 plików + case-index.sqlite
   collective/  71+ plików (Model D governance)
   reflections/ (refleksje agenta)
   system/      (startup/shutdown/errors)

5. soul-memory.json (~/.memphis/config/)
   user/self/context — NIEZALEŻNY od case entries
   Soul seed tworzy 8 foundational case entries PRZY FIRST BOOT
   Potem żyją osobno
```

---

## Providers — 7 + Który Jest Używany Gdzie

| Provider | Gdzie | Env |
|---|---|---|
| `local-fallback` | RuntimeRegistry | `LOCAL_FALLBACK_ENABLED` |
| `shared-llm` | RuntimeRegistry | `SHARED_LLM_API_BASE+KEY` |
| `decentralized-llm` | RuntimeRegistry | `DECENTRALIZED_LLM_API_BASE+KEY` |
| `ollama` | RuntimeRegistry + factory | `OLLAMA_URL` (zawsze) |
| `minimax` | RuntimeRegistry + factory | `MINIMAX_API_KEY` |
| `deepseek` | RuntimeRegistry + factory | `DEEPSEEK_API_KEY` |
| `glm` | RuntimeRegistry + factory | `GLM_API_KEY` |

**Provider NIE zapisuje bezpośrednio do storage.** Storage to oddzielna warstwa HTTP/Gateway.

**DynamicRouter = CLI tool do testowania, NIE HTTP path.**

---

## Security — 4-Tier Approval Hierarchy

```
1. unknown tool → deny
2. explicit SQLite policy (operator override) ← najwyższy priorytet
3. trust rule (soul manifest) → autoApprove=true → allow
4. mode + tier defaults:
   quiet: tier≤1 → allow, tier>1 → require-approval
   balanced: tier=0 → allow, tier>0 → require-approval
   paranoid: wszystko → require-approval

Tier 0 (none): journal, recall, search, decide, health, soul_read, soul_write, case_append, case_query, loop_step
Tier 1 (api_token): web_fetch
Tier 2 (vault_passphrase): exec, self_modify
```

---

## Soul Memory — Co to jest, jak działa

```
~/.memphis/config/soul-memory.json
  Schema: user (name, languages, preferences, expertise, integrations)
          self (personality, strengths, learnings, evolvedCapabilities)
          context (activeWork, recentDecisions)

buildSoulBootPrompt() → <soul_boot> — pyta o imię, języki, styl
buildSoulManifestFragment() → <soul_manifest> — identity + capabilities
buildSoulMemoryFragment() → <soul_memory> — user + self + context

seedSoulIdentity() (first boot ONLY):
  → zapisuje soul-memory.json
  → 5 journal entries (identity, architecture, capabilities, providers, boundaries)
  → 8 case entries (po jednym na każdy przypadek gramatyczny)
  → potem żyje własnym życiem

CaseEntries ≠ SoulMemory — to ODRĘBNE systemy!
Jedyń punkt styku: soul seed tworzy case entries przy first boot.
```

---

## Co Wiemy Na Pewno (vs. Co Było Mitami)

### FAŁSZ (poprzednie rozumienie):
- ❌ "Commander = CLI parser" → własny parser, commander jest MARTWY
- ❌ "Anthropic SDK = główny LLM" → ZERO importów, tylko string 'anthropic'
- ❌ "DynamicRouter w HTTP path" → NIE, to CLI tool do testowania
- ❌ "Provider zapisuje do storage" → NIE, storage to oddzielna warstwa
- ❌ "Discord jest w kanale" → NIE, tylko Telegram zaimplementowany
- ❌ "memphis-napi ma logikę" → PUSTY, cała logika w memphis-operator
- ❌ "MCP w ścieżce serve" → ODRĘBNY PROCES, memphis mcp serve
- ❌ "CaseIndex = FTS5" → denormalized columns + indeksy

### PRAWDZIWE:
- ✅ 7 Rust crates w grafie zależności
- ✅ 35+ Fastify routes (nie tylko /api/status)
- ✅ 14 MCP tools (nie 11/12)
- ✅ Vault = XChaCha20-Poly1305 + Argon2id + HKDF v2
- ✅ 10 tooli w tier 0, 1 w tier 1, 2 w tier 2
- ✅ 5 warstw storage (nie jedna baza)
- ✅ TUI ma DWA kanały: direct Rust + stdio JSON TS host
- ✅ 3 oddzielne tryby uruchomienia

---

## Gdzie Szukać Czego

| Szukasz | Plik |
|---|---|
| Entry point | `src/index.ts` |
| CLI parser | `src/infra/cli/parser.ts` |
| CLI dispatcher | `src/infra/cli/dispatcher.ts` |
| Bootstrap | `src/app/bootstrap.ts` |
| DI Container | `src/app/container.ts` |
| Fastify server | `src/infra/http/server.ts` |
| HTTP routes | `src/infra/http/routes/` |
| Providers factory | `src/providers/index.ts` |
| DynamicRouter | `src/providers/dynamic-router.ts` |
| Chat loop | `src/gateway/chat-loop.ts` |
| Tool executor | `src/gateway/tool-executor.ts` |
| MCP server | `src/mcp/server.ts` |
| Soul memory | `src/soul/boot.ts`, `seed.ts`, `types.ts` |
| Vault | `crates/memphis-vault/src/vault.rs` |
| Case entries | `crates/memphis-core/src/case_entry.rs` |
| Case index | `crates/memphis-case-index/src/lib.rs` |
| Embed | `crates/memphis-embed/src/` |
| Operator | `crates/memphis-operator/src/lib.rs` |
| TUI | `crates/memphis-tui/src/app.rs`, `client.rs` |
| Extension host | `src/infra/tui-host/index.ts` |
| Approval | `src/gateway/authorization.js` |
| NAPI bridge | `crates/memphis-napi/` (pusty lib.rs, logika w operator) |
