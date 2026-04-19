# Memphis — Team Start Guide (v2)

**Data:** 2026-03-28 (rano)
**Status:** ✅ ZWERYFIKOWANE — 10 agentów, ~2h skanowania
**Poranny start:** `memory/MEMPHIS-MAPA-SWIADOMOSCI.md` — krotki snapshot z jawnym drift logiem i lista od czego zaczac rano.

---

## ⚠️ POPRAWKI vs. poprzednie rozumienie

| Mit                            | Prawda                                              |
| ------------------------------ | --------------------------------------------------- |
| "Commander = CLI parser"       | Własny parser w `parser.ts`, commander MARTWY       |
| "DynamicRouter w HTTP path"    | NIE — to CLI tool do testowania routingu            |
| "Provider zapisuje do storage" | NIE — storage to oddzielna warstwa                  |
| "MCP w ścieżce serve"          | NIE — osobny proces: `memphis mcp serve`            |
| "Discord jako kanał"           | NIE — tylko Telegram jest zaimplementowany          |
| "memphis-napi ma logikę"       | PUSTY lib.rs — cała logika w memphis-operator       |
| "CaseIndex = FTS5"             | NIE — denormalized columns + kompozytowe indeksy    |
| "Anthropic SDK = LLM"          | ZŁOŻONE — zero importów, martwy wpis w package.json |

---

## 3 Tryby Uruchomienia

```
memphis serve      → TS bootstrap + Fastify + (opcjonalny) Telegram
memphis rust-tui  → Pure Rust TUI + OperatorRuntime (bez TS)
memphis mcp serve → Osobny MCP server (14 tools)
```

---

## Jak Działa `memphis serve`

```
memphis serve
  → bootstrap() [16 kroków]:
    1. .env check
    2. checkRustToolchain()
    3. loadConfig() → Zod schemas
    4. startAlertSuppressionFlushLoop()
    5. runStartupSecurityGuards() → trust root + revocation cache
    6. safeMode enforcement
    7. checkOllama() (jeśli embed=ollama)
    8. verifyChainIntegrity() → NAPI bridge
    9. ensureSoulManifest()
    10. seedSoulIdentity() (FIRST BOOT ONLY)
    11. createAppContainer() → DI: 10 repos + providers + orchestration
    12. resumeRecoveredQueueTasks()
    13. createHttpServer() → Fastify (35+ routes)
    14. app.listen() → HTTP NASŁUCHUJE
    15. startChannelGateway() → Telegram (jeśli enabled)
    16. scheduleReflection() → 5min + co 24h
```

---

## Rust Crates (7) — Graf Zależności

```
memphis-core          ← vault (dev), embed (dev), case-index, operator, napi (dev)
  Block, chain, hash, signature, soul, loop_engine, case_entry, harness

memphis-vault        ← operator, napi
  XChaCha20-Poly1305 + Argon2id + HKDF v2 2FA

memphis-embed        ← operator, napi (dev)
  LocalDeterministic (32w) LUB Ollama HTTP (768w)

memphis-case-index   ← operator, napi
  SQLite + denormalized columns + kompozytowe indeksy

memphis-operator     ← uzywa: core + vault + embed + case-index
  Chat + chains + vault + memory + security filtering
  WSZYSTKIE 4 crate'y razem
  ← TYLKO UŻYWANY PRZEZ: memphis-tui (direct Rust call)

memphis-napi         ← pusty lib.rs!
  Wrapper cdylib — cała logika W operatorze

memphis-tui          ← operator (API) + stdio JSON (TS host)
  7 ekranów + MemphisClient (direct + stdio JSON)
```

---

## Storage (5 Warstw)

```
1. memphis.db            → SQLite: sessions, approvals, generation_events
2. case-index.sqlite     → SQLite: case entries (NIE FTS5!)
3. embed/memphis.db     → SQLite: embeddings + audit log
4. chains/               → JSON append-only: journal, decisions, cases...
5. soul-memory.json      → JSON: user/self/context (NIE case entries!)
```

---

## Providers (7)

```
local-fallback, shared-llm, decentralized-llm, ollama, minimax, deepseek, glm
```

**DynamicRouter = CLI tool `memphis route`, NIE część HTTP path.**

**Provider NIE zapisuje do storage.** Storage to oddzielna warstwa HTTP/Gateway.

---

## Tools (14 MCP, 3 Tiery)

```
Tier 0 (none): journal, recall, search, decide, health, soul_read, soul_write, case_append, case_query, loop_step
Tier 1 (api_token): web_fetch
Tier 2 (vault): exec, self_modify
```

**Tier 2 wymaga operator approve: `memphis config tools approve-call <request_id>`**

---

## Gdzie Szukać Czego

| Szukasz     | Plik                                |
| ----------- | ----------------------------------- |
| Bootstrap   | `src/app/bootstrap.ts`              |
| CLI parser  | `src/infra/cli/parser.ts`           |
| Fastify     | `src/infra/http/server.ts`          |
| HTTP routes | `src/infra/http/routes/`            |
| Gateway     | `src/gateway/chat-loop.ts`          |
| MCP         | `src/mcp/server.ts`                 |
| Providers   | `src/providers/index.ts`            |
| Soul        | `src/soul/boot.ts`                  |
| Vault       | `crates/memphis-vault/src/vault.rs` |
| TUI         | `crates/memphis-tui/src/app.rs`     |

---

## Pełna Mapa

`memory/MEMPHIS-ARCHITECTURE-MAP-2026-03-27.md` (14KB zweryfikowanych faktów)

**Baza danych:** `life.db` — query przez `node life-queries.js`
