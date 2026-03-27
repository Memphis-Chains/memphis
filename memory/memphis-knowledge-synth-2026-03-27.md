# Memphis — Pełna Wiedza (zweryfikowana 2026-03-27)

Wygenerowane przez 5 równoległych agentów skanujących kod źródłowy. Wszystko = fakty z plików, nie domysły.

---

## A: INFRA (CLI + Fastify + MCP)

### CLI Parser
- **Plik:** `src/infra/cli/parser.ts`
- **Własny parser** — iteruje po `argv`, rozpoznaje `--flag value` i `--flag` (boolean), positional arguments
- **60+ flag**: `--json`, `--check-only`, `--run-command`, `--stdio-json`, `--tui`, `--write`, `--save`, `--input`, `--session`, `--provider`, `--model`, `--file`, `--out`, `--confirm-write`, `--key`, `--value`, `--passphrase`, `--operator-passphrase`, `--recovery-question`, `--recovery-answer`, `--id`, `--query`, `--register`, `--to`, `--latest`, `--port`, `--transport`, `--duration-ms`, `--top-k`, `--tuned`, `--strategy`, `--interactive`, `--non-interactive`, `--profile`, `--force`, `--no-vault`, `--fix`, `--deep`, `--apply`, `--dry-run`, `--yes`, `--schema`, `--verbose`, `--max-tokens`, `--context-window`, `--temperature`, `--system-prompt`, `--task-type`, `--priority`, `--min-context`, `--vision`, `--functions`, `--size`, `--reset`, `--runtime`, `--chain`, `--cid`, `--recipient`, `--blocks`, `--offer-id`, `--days`, `--repo-path`, `--agent`, `--list`, `--clean`, `--restore`, `--keep`, `--tag`, `--format`, `--interval`, `--safe-mode`, `--strictMode`, `--telegram`, `--fault-inject`, `--state`, `--action`, `--limits`
- **Dispatcher:** `src/infra/cli/dispatcher.ts`
- **Komendy** w `src/infra/cli/commands/`: apps, backup, cognitive, configure, debug, decision, explain, interaction, mcp, rust-tui, serve, service, setup-matrix-prereqs, setup-matrix, setup, storage, sync, workspace

### Fastify Routes (35+)
**Plik:** `src/infra/http/server.ts`

Inline routes (22):
| Method | Path | Handler |
|---|---|---|
| GET | `/health` | health |
| GET | `/v1/providers/health` | providers health |
| GET | `/metrics` | Prometheus |
| GET | `/v1/metrics` | internal metrics |
| GET | `/api/status` | system status dashboard |
| GET | `/dashboard` | HTML dashboard |
| GET | `/v1/ops/status` | ops status + startup |
| POST | `/v1/vault/init` | init vault |
| POST | `/v1/vault/encrypt` | encrypt |
| POST | `/v1/vault/decrypt` | decrypt |
| GET | `/v1/vault/entries` | list vault |
| POST | `/v1/admin/dual-approval/request` | request dual approve |
| POST | `/v1/admin/dual-approval/approve` | approve |
| POST | `/v1/admin/dual-approval/cancel` | cancel |
| GET | `/v1/admin/dual-approval/:requestId` | get state |
| GET | `/v1/sessions` | list sessions |
| GET | `/v1/sessions/:sessionId/events` | session events |
| POST | `/v1/soul/replay` | replay soul |
| POST | `/v1/soul/loop-step` | soul loop step |
| POST | `/api/model-d/proposals` | Model D proposals |
| POST | `/api/decide` | append decision |

Plus: `registerChatRoutes`, `registerChatCompletionsRoutes`, `registerConfigRoutes`, `registerMemoryRoutes`, `registerWebhookRoutes`, `registerFederationRoutes`, `registerAnalyticsRoutes`, `registerTaskRoutes`

### MCP Server (15 tools)
**Plik:** `src/mcp/server.ts` — `@modelcontextprotocol/sdk` v0.3.4

| Tool | Tier | Auth |
|---|---|---|
| `memphis_journal` | 0 | none |
| `memphis_recall` | 0 | none |
| `memphis_search` | 0 | none |
| `memphis_decide` | 0 | none |
| `memphis_health` | 0 | none |
| `memphis_web_fetch` | 1 | api_token |
| `memphis_loop_step` | 0 | none |
| `memphis_exec` | 2 | vault_passphrase |
| `memphis_case_append` | 0 | none |
| `memphis_case_query` | 0 | none |
| `memphis_soul_read` | 0 | none |
| `memphis_soul_write` | 0 | none |
| `memphis_self_modify` | 2 | vault_passphrase |

Wszystkie przechodzą przez `withApprovalGate()` — Tier 2 wymaga operator approval.

### Inne `src/infra/` (~30 modułów)
auth/, cache/, config/, embeddings/, git-utils.ts, health-monitor.ts, logging/, memory/, observability.ts, operator-guide.ts, ops/, retry.ts, runtime/, secret-awareness.ts, storage/, test-gate.ts, tui-host/, transport/, tools/, auth-policy.ts, error-handler.ts, health.ts, path-validation.ts, rate-limit.ts, contracts.ts, chat-turn.ts, context.ts, dispatcher.ts, handlers/, import-json.ts, interactive-chat.ts, onboarding-wizard.ts, provider-capabilities.ts, types.ts, utils/

---

## B: RUST CRATES (7 crates)

### memphis-core
**Lokalizacja:** `crates/memphis-core/`
- Fundament: bloki, łańcuchy, hashowanie SHA-256, podpisy, walidacja soul
- **Bloki:** Journal, Decision, SystemEvent, Case, SecurityEvent
- **LoopEngine:** LoopState, LoopAction, LoopLimits
- **CaseEntry:** 7 przypadków gramatycznych (Genitive, Nominative, Locative, Accusative, Dative, Instrumental, Factitive)
- **API:** `hash::compute_hash()`, `sign_block()`, `verify_block_signature_with_allowlist()`, `validate_block()`, `validate_block_strict()`, `harness::replay()`
- **Moduły:** block, chain, hash, signature, soul, loop_engine, case_entry, memory, harness

### memphis-vault
**Lokalizacja:** `crates/memphis-vault/`
- XChaCha20-Poly1305 (AEAD) + Argon2id dla master key derivation
- Opcjonalna 2FA przez Q&A challenge z HKDF v2
- **API:** `Vault::init_full()`, `vault.store()`, `vault.retrieve()`, `derive_master_key_v2()`, `QAChallenge::verify()`
- **Moduły:** vault, crypto, keyring, two_factor, error, types

### memphis-embed
**Lokalizacja:** `crates/memphis-embed/`
- Dwa tryby: `LocalDeterministic` (32 wymiary, deterministyczny hash, in-process) LUB `Provider` (OpenAI-compatible, Ollama, Cohere, Voyage, Jina, Mistral, Together, NVIDIA, Mixedbread)
- **API:** `EmbedPipeline::new()`, `pipeline.upsert_with_tags()`, `pipeline.search_with_tags()`, `pipeline.search_tuned_with_tags()`
- **LRU cache** w pamięci
- **Moduły:** pipeline, store, cache

### memphis-case-index
**Lokalizacja:** `crates/memphis-case-index/`
- SQLite + FTS5 dla case chain blocks
- **API:** `CaseIndex::open()`, `case_index.index_block()`, `case_index.query()`, `case_index.rebuild()`
- **Zależności:** memphis-core (Block, BlockType::Case)

### memphis-operator
**Lokalizacja:** `crates/memphis-operator/`
- Główny orchestrator: chat, chains, memory, vault, soul, security filtering
- **API:** `OperatorRuntime::from_env()`, `runtime.snapshot()`, `runtime.chat()`, `runtime.chat_stream()`, `runtime.chat_stream_with_cancel()`, `runtime.chat_session()`, `runtime.search_semantic()`, `runtime.search_exact()`, `runtime.read_vault_secret()`, `runtime.provider_statuses()`
- **Natywne tools:** memphis_journal, memphis_recall, memphis_search, memphis_health, memphis_soul_read, memphis_soul_write, memphis_case_query, memphis_case_append, memphis_vault_list
- **Security:** `classify_input()`, `guard_model_output()`, `scan_memory_content()` — blokuje invisible unicode, prompt injection, role hijack
- **Zależności:** memphis-core, memphis-vault, memphis-case-index, memphis-embed
- **Moduły:** runtime, chat, provider, config, error

### memphis-napi
**Lokalizacja:** `crates/memphis-napi/`
- Rust → Node.js bridge (NAPI-RS)
- **API:** `chain_validate()`, `chain_append()`, `chain_query()`, `vault_init_json()`, `embed_store()`, `embed_search()`, `embed_search_tuned()`, `embed_reset()`, `soul_loop_step()`, `soul_replay()`, `case_append()`, `case_query()`, `case_rebuild()`
- **NAPI objects:** JsVault, JsVaultEntry, JsVaultInitResult
- **Zależności:** memphis-core, memphis-vault, memphis-embed, memphis-case-index

### memphis-tui
**Lokalizacja:** `crates/memphis-tui/`
- Terminal TUI cockpit: Crossterm-based
- **7 ekranów:** Overview, Chat, Memory, Sessions, Vault, Cases, System
- **API:** `AppState::new()`, `app.refresh()`, `app.handle_key()`, `app.render_view()`, `MemphisClient::new()`, `client.fetch_snapshot()`, `client.stream_chat_with_cancel()`, `client.run_extension_command_with_cancel()`
- **Extension host bridge:** stdio JSON do TypeScript host
- **CLI fallback:** `memphis --json` one-shot compatibility
- **Zależności:** memphis-operator

---

## C: TYPESCRIPT RUNTIME (Providers + Channels + Tools + Prompts)

### Providers (7)
**Fabryka:** `src/providers/factory.ts` → `createConfiguredRuntimeProviders()`

| Provider | Adapter | Env |
|---|---|---|
| `local-fallback` | LocalFallbackProvider | `LOCAL_FALLBACK_ENABLED` |
| `shared-llm` | SharedLlmProvider + SharedLlmClient | `SHARED_LLM_API_BASE`, `SHARED_LLM_API_KEY` |
| `decentralized-llm` | DecentralizedLlmProvider | `DECENTRALIZED_LLM_API_BASE` |
| `ollama` | OllamaProvider | `OLLAMA_URL` (always) |
| `minimax` | MinimaxProvider | `MINIMAX_API_KEY` |
| `deepseek` | OpenAICompatibleProvider | `DEEPSEEK_API_KEY` |
| `glm` | GlmProvider | `GLM_API_KEY` |

**Routing:** `DynamicRouter` w `dynamic-router.ts` — wybiera po `taskType` (chat/code/analysis/creative), `priority` (latency/cost/quality), `requirements` (minContextWindow, needsVision, needsFunctionCalling)

### Channel Adapters
**Katalog:** `src/gateway/channels/`

**Telegram** (`telegram.ts` → `createTelegramAdapter`):
- Biblioteka: `grammy` (Bot)
- `start(handler)` — handluje `start`, `help`, `status`, `recall`, `message:text`
- `send(chatId, text)` — `splitText()` po 4096 znaków, `bot.api.sendMessage()`
- Allowlist: `TELEGRAM_ALLOWED_USER_IDS`

**Discord** (`discord.ts` → `createDiscordAdapter`):
- Biblioteka: `discord.js` (Client, Intents: GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES)
- `send(chatId, text)` — `splitText()` po 2000 znaków

### Tool Registry (13 tools, 3 tiery)
**Plik:** `src/gateway/tool-registry.ts` + `tool-executor.ts`

Tier 0 (auth: none): memphis_journal, memphis_recall, memphis_search, memphis_decide, memphis_health, memphis_soul_read, memphis_soul_write, memphis_case_append, memphis_case_query, memphis_loop_step

Tier 1 (auth: api_token): memphis_web_fetch

Tier 2 (auth: vault_passphrase): memphis_exec, memphis_self_modify

**Execution:** `createInProcessToolExecutor()` — wykonuje bezpośrednio, nie przez HTTP MCP. Każde wywołanie przechodzi przez `resolveToolPolicy()` z `authorization.js`.

### Prompt Assembly
**Plik:** `src/gateway/system-prompt.ts`, `chat-loop.ts`, `agent-runtime.ts`, `soul/boot.ts`

System prompt XML-bloki:
```
<memphis_system>
  <identity>...</identity>
  <architecture>...</architecture>
  <warnings>...</warnings>
  <behavior>THINK/RECALL/DECIDE/JOURNAL rules...</behavior>
  <tools>per-tool XML instructions</tools>
  <output_format>...</output_format>
</memphis_system>

<user_input>
  <risk_annotation>...</risk_annotation>  (if risky)
</user_input>

<fetched_content>...</fetched_content>
<recalled_memory>...</recalled_memory>
```

**Input risk classification** (`prompt-boundary.ts`): 6 kategorii — instruction_override, role_hijack, secret_fishing, prompt_exfiltration, tool_manipulation, command_injection

**Output guard:** `guardModelOutput()` — filtruje system prompt leak, API tokens, vault secrets

**Soul boot:** `buildSoulBootPrompt()` — oddzielny prompt gdy soul memory pusta

---

## D: DEPENDENCIES (16 w package.json)

### Faktycznie używane (13):
| Pakiet | Gdzie | Co robi |
|---|---|---|
| `@modelcontextprotocol/sdk` | mcp/server.ts, mcp/transport/ | MCP server implementation |
| `better-sqlite3` | infra/storage/sqlite/client.ts + 12 repozytoriów | SQLite storage layer |
| `chalk` | cli/utils/render.ts, cli/commands/* | Kolorowanie CLI |
| `cli-progress` | cli/commands/backup.ts | Pasek postępu backup |
| `discord.js` | gateway/channels/discord.ts | Discord adapter |
| `dotenv` | infra/config/env.ts | Env loading |
| `fastify` | infra/http/server.ts, error-handler.ts | HTTP server |
| `grammy` | gateway/channels/telegram.ts | Telegram adapter |
| `pino` | app/bootstrap.ts, gateway/session-store.ts, chat-loop.ts, agent-runtime.ts | Logger JSON |
| `prompts` | cli/commands/configure.ts | Interaktywne prompty |
| `yaml` | cli/utils/doctor-v2.ts, cli/commands/configure.ts, config/index.ts | YAML parsing |
| `zod` | 12 plików (config, http, mcp, soul, modules) | Walidacja schematów |

### NIE używane (3):
| Pakiet | Mit | Rzeczywistość |
|---|---|---|
| `@anthropic-ai/sdk` | "główny silnik LLM" | Zero importów — tylko string `'anthropic'` w CLI |
| `commander` | "CLI parser" | Zero importów — własny dispatcher w `src/infra/cli/` |
| `ollama` npm | "integracja Ollama" | Zero importów — runtime przez zewnętrzny binary `ollama` |

---

## E: PERSISTENCE (5 baz + filesystem)

### SQLite: memphis.db
**Lokalizacja:** `~/memphis/data/memphis.db`
**Silnik:** better-sqlite3, WAL mode
**Konfiguracja:** `DATABASE_URL=file:./data/memphis.db`

**Tabele (15):**
- `_meta` — wersje migracji
- `sessions` — sesje agentów
- `generation_events` — logi generowania (provider, model, timing)
- `approvals` — single approve
- `dual_approval_requests` — dual-approve requests
- `dual_approval_events` — event log
- `dual_approval_idempotency` — idempotency keys
- `tool_permissions` — tool_name → policy (allow/deny/require-approval)
- `tool_call_approvals` — per-call approvals
- `evolve_sessions` — sesje ewolucji kodu
- `seen_proposals` — proposal idempotency
- `scheduled_jobs` — zaplanowane zadania
- `webhook_events` — webhook eventy
- `agent_peers` — peer registry
- `memory_search_entries` + FTS5 — full-text search

### SQLite: case-index.sqlite
**Lokalizacja:** `~/.memphis/case-index.sqlite` (~40KB)
**Silnik:** Rust NAPI (memphis-napi)
**Backend:** FTS5 + strukturalne kolumny (case_type, entity, actor, target, instrument, location...)

### SQLite: embed/memphis.db
**Lokalizacja:** `~/.memphis/embed/memphis.db` (~335KB + 4MB WAL)
**Zawiera:** embed pipeline persistence + queue + security audit + sync state

### life.db (workspace)
**Lokalizacja:** `~/.openclaw/workspace/life.db`
**31 tabel** w 6 grupach:
- **Projekty:** projects, milestones, todos, goals, finances
- **Ludzie:** contacts, habits
- **Agenci:** agents, workspaces, workspace_members, tool_policies
- **Tier & Agora:** tier_definitions, agora_nodes
- **Memphis Arch:** architecture_design, architecture_components, memphis_modules, memphis_components, memphis_mcp_tools, memphis_db_tables, memphis_cli_commands, memphis_http_routes, memphis_chains, memphis_providers, memphis_dependencies, memphis_architecture, memphis_npm_packages, memphis_issues, memphis_arch_summary
- **Klienci:** client_profiles
- **Decyzje:** decisions

### Filesystem: ~/.memphis/chains/ (JSON append-only)
```
~/.memphis/chains/
├── cases/        — 8 plików case entries (gramatyka przypadków)
├── collective/   — 71+ plików (Model D proposals)
├── decisions/   — 14 plików decyzji
├── journal/      — 13 plików journal
├── reflections/  — reflections
└── system/       — system events
```
Format: `{chain, index, timestamp, prev_hash, hash, data: {type, content, tags}}`

### Dwie warstwy embeddings:
1. **Rust LocalDeterministic** (`memphis-embed`) — 32 wymiary, deterministyczny, in-process
2. **Ollama HTTP** — 768 wymiarów, opcjonalny (port 11434)

---

## MAPA: 7 warstw Memphis

```
┌─────────────────────────────────────────────────────┐
│  Rust TUI (memphis-tui) — 7 ekranów                │
│    ↓ MemphisClient (extension host / CLI fallback)  │
├─────────────────────────────────────────────────────┤
│  memphis-operator — orchestrator + native tools    │
│    ├── memphis-core — bloki, chainy, loop engine   │
│    ├── memphis-vault — XChaCha20 + 2FA             │
│    ├── memphis-embed — embeddings (local lub HTTP)  │
│    └── memphis-case-index — FTS5 case search        │
│    ↓ NAPI bridge                                    │
├─────────────────────────────────────────────────────┤
│  TypeScript Runtime                                 │
│    ├── Provider runtime (7 providers + DynamicRouter)│
│    ├── Channel adapters (Telegram grammy, Discord)  │
│    ├── Tool executor (13 tools, 3 tiery)            │
│    └── Prompt assembly (XML blocks + risk classify) │
├─────────────────────────────────────────────────────┤
│  Infra                                             │
│    ├── CLI (własny parser, 60+ flags, 16 commands)  │
│    ├── Fastify (35+ routes)                         │
│    └── MCP server (15 tools, approval gating)       │
├─────────────────────────────────────────────────────┤
│  Storage                                           │
│    ├── memphis.db (sessions, approvals, jobs...)    │
│    ├── case-index.sqlite (case search)              │
│    ├── embed/memphis.db (embeddings + audit)        │
│    ├── ~/.memphis/chains/* (JSON append-only)       │
│    └── life.db (workspace: 31 tabel)               │
└─────────────────────────────────────────────────────┘
```
