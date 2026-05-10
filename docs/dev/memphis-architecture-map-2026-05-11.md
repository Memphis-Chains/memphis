# Memphis Architecture Map — 2026-05-11

**Generated:** parallel Explore agent scan, 2026-05-11.
**Scope:** Memphis v1.8.0 OSS — TypeScript orchestration + Rust NAPI core.
**Audience:** human operator — research base do planowania kolejnych sprintów i briefów dla koderów.

> Note: for bot's own consumption see `memphis-self-map-2026-05-11.md` (machine-readable index, designed dla `memphis_code_read` przy session start).

---

## 1. Top-level layout

Root directories (v1.8.0):

| Dir | Purpose |
|---|---|
| `crates/` | 9 Rust NAPI bindings & services (core, vault, tui, operator, embed, case-index, paths, export) |
| `src/` | 28 TypeScript subsystems (agent logic, gateway, providers, security, storage) |
| `bin/` | CLI entry points (`memphis.js`, `memphis` bash wrapper) |
| `dist/` | Compiled JS output (tsc target) |
| `target/` | Rust build artifacts (memphis-tui binary) |
| `data/` | Local runtime data (memphis.db, embed-index) |
| `docs/` | User + dev documentation |
| `notes/` | Research notes (ADRs, design memos) |
| `tests/` | Vitest + integration tests |
| `benchmarks/`, `audit/`, `reviews/` | QA & governance |
| `scripts/` | Setup + install + ops automation |
| `tools/`, `ops/`, `deploy/`, `compose/` | Infrastructure & deploy automation |
| `apps/` | (planned) `apps/memphis-gui/` Tauri GUI — Phase G nie zaczęta |

---

## 2. Rust crates (`crates/memphis-*`)

| Crate | Purpose | Touches 6mo |
|-------|---------|---|
| **memphis-core** | Block chain encoding/validation, cryptographic integrity (merkle roots) | 36 |
| **memphis-vault** | AES-256 encryption, DID keyring, two-factor auth, secrets management (8 modules) | 57 |
| **memphis-napi** | Node.js native addon bindings (chain operations, vault ops at speed) | 60 |
| **memphis-tui** | Terminal UI cockpit; Rust standalone binary communicates with TS host via stdio JSON | 97 |
| **memphis-operator** | Agent behavioral constraints, execution policies, runtime sandboxing, provider routing | 79 |
| **memphis-embed** | Vector embeddings dla semantic search & pattern matching (Phase 1 bulk + flush + NDJSON v2) | 35 |
| **memphis-case-index** | Case database indexing (FTS5 SQLite dla exact & semantic search) | — |
| **memphis-paths** | File path normalization & sandbox boundary enforcement | — |
| **memphis-export** | Chain serialization to external formats (archive, restore) | — |

---

## 3. TypeScript subsystems (`src/` — 28 dirs)

### Core runtime
- **`gateway/`** — Turn execution loop (1.4K LOC), provider adapters, tool registry (1.3K LOC), system prompt (1.5K LOC), anti-confab audit, 5 channel handlers (Telegram 41K)
- **`agent/`** — Agent orchestration & lifecycle
- **`app/`** — Bootstrap & startup sequence

### Cognition & decision
- **`cognitive/`** — 5 model variants (A–E) dla multi-path reasoning + proactive-assistant
- **`decision/`** — Decision branching, policy evaluation, reflection loops
- **`reflection/`** — Self-observation chains

### Storage & memory
- **`core/`** — Chain index rebuild, decision-chain logic, decision audit logs
- **`memory/`** — Chain catalog, abstraction, in-memory views
- **`infra/storage/`** — Chain adapters (TS + Rust bridge), file I/O, rotation, archive/restore
- **`infra/cache/`** — Chain-aware caching layer
- **`sync/`** — Network chain diffing, federation sync

### Providers & cognitive adapters
- **`providers/`** — 5 LLM adapters: Anthropic, GLM, shared-llm, decentralized-llm, local-fallback (plus inline Ollama, MiniMax)
- **`bridges/`** — External service integrations

### Security & execution
- **`security/`** — Vault boundary, tier-3 session sandbox, integrity checks, content scanning, constant-time comparison
- **`mcp/`** — 41 tools (registry 1.3K LOC), MCP server on :3001, health monitor, observability
- **`resilience/`** — Retry logic, failure recovery

### Infrastructure
- **`infra/cli/`** — CLI parser, doctor diagnostics, onboarding flows
- **`infra/http/`** — HTTP server, routing
- **`infra/tui-host/`** — Rust TUI ↔ TS host protocol bridge
- **`infra/runtime/`** — Chain rotation loops, emergency logs, exit codes, install-root resolver
- **`observability/`** — Metrics, tracing, monitoring
- **`config/`** — Configuration management

### Semantic & identity
- **`kartograf/`** — Knowledge graph construction, semantic mapping (Q2 N32 deferred)
- **`soul/`** — Identity persistence (soul-manifest.json, soul-memory.json)
- **`onboarding/`** — Initial setup flows

### Auxiliary
- **`modules/`, `federation/`, `trajectory/`, `backup/`, `dashboard/`** — Feature modules

---

## 4. Key flow paths — request → response

**1. Telegram surface:**
```
Telegram polling
  → src/gateway/channels/telegram.ts
    ├─ :624 text handler
    ├─ :751 voice handler (STT pipeline)
    └─ :834 photo handler (vision + OCR)
  → src/gateway/turn-runtime.ts (single-turn orchestration, 1.4K LOC)
  → provider adapter (anthropic / minimax / ollama / etc.)
  → reply → bot.api.sendMessage / sendVoice (line :996)
```

**2. HTTP surface:**
```
HTTP request → src/infra/http/server.ts → routes → turn-runtime.ts
```

**3. TUI surface:**
```
target/debug/memphis-tui (Rust binary)
  ↕ stdio JSON protocol (src/infra/tui-host/protocol.ts)
  ↕ src/infra/tui-host/commands.ts (35K LOC: slash commands, runtime bridge)
  → turn-runtime.ts
```

**4. MCP surface (optional):**
```
External MCP client → :3001 → src/mcp/server.ts
  → 41 tools in src/mcp/tools/*.ts
```

---

## 5. Core execution layer

| Plik | Co | LOC |
|---|---|---|
| `src/gateway/turn-runtime.ts` | Single-turn orchestration (anti-confab, provider call, tool exec, persistence) | 1.4K |
| `src/gateway/agent-runtime.ts` | Multi-turn agent behavior, planning horizons | — |
| `src/gateway/tool-executor.ts` | Dispatches tool calls, handles permissions | 1.4K |
| `src/gateway/tool-registry.ts` | 41 MCP tools catalog + tier/feature gating | 1.3K |
| `src/gateway/system-prompt.ts` | Prompt engineering (tool docs, autonomy rules, anti-confab) | 1.5K |
| `src/gateway/anti-confab-audit.ts` | Fact-checking forbidden phrases (rule A/D/C/E) | — |

---

## 6. Storage layout `~/.memphis/`

```
chains/                          append-only blocks per chain
  ├─ journal/                    raw events
  ├─ decisions/                  decision tree
  ├─ reflections/                self-observation (Model E output)
  ├─ cases/                      learned patterns (Polish grammar roles)
  ├─ patterns/                   behaviors (Model C cache)
  ├─ system/                     runtime state + security events
  ├─ collective/                 federation
  ├─ insights/                   semantic summaries (Model B output)
  └─ soul/                       identity blocks

config/
  ├─ soul-memory.json            bot identity (user/self/context)
  ├─ soul-manifest.json          autonomy mode, trust rules, tier-2 hash
  ├─ agent-profile.json          public profile
  └─ scheduler/
      ├─ tasks.json              cron tasks (6 default)
      └─ logs/                   per-task logs

vault-state.json                 encrypted master key (pepper-wrapped)
vault-entries.json               encrypted secrets (master-key-encrypted)
data/memphis.db                  SQLite (sessions, FTS5 exact-search 3000+ entries)
embed-index.json or .ndjson      embed vectors (Phase 1: NDJSON v2 opt-in)
logs/memphis.log                 rotated runtime log
logs/piper-server.log            Piper TTS log (rotated)
logs/whisper-server.log          Whisper STT log
backups/                         backup snapshots (memphis backup output)
docs/                            operator-generated docs (bot's briefs też tu lądują)
```

---

## 7. Cross-cutting concerns — gdzie szukać

| Concern | Where to Look |
|---------|---------------|
| **Hallucination prevention** | `gateway/anti-confab-audit.ts` + `turn-runtime.ts:1038+` |
| **Sandbox & tier policies** | `security/tier3-session.ts` + `mcp/tools/fs-permission.ts` |
| **Chain integrity** | Rust: `crates/memphis-core/src/block.rs`; TS: `chain-adapter.ts` |
| **Identity persistence** | `soul/` + `config/soul-manifest.json` + `config/soul-memory.json` |
| **Vector search** | `crates/memphis-embed/` + `kartograf/` |
| **Encryption** | `crates/memphis-vault/` (AES-256, DID keyring) + `security/vault-boundary.ts` |
| **Tool execution** | `gateway/tool-executor.ts` + `gateway/tool-registry.ts` |
| **Provider switching** | `providers/*/adapter.ts` + `gateway/cognitive-runtime.ts` + `modules/orchestration/service.ts` |
| **Install-root resolution** | `infra/runtime/install-root.ts` (Phase 4 + 5 anchored everywhere) |
| **Voice stack** | `gateway/voice/` (service, adapters, policy) + `gateway/channels/telegram.ts` (handlers) |
| **Media pipeline** | `gateway/media/` (orchestrator, vision, OCR, audio, chain-output) |

---

## 8. Operator's path to understand changes

1. **Nowy feature** → check `src/gateway/turn-runtime.ts` (execution flow)
2. **Storage change** → `src/infra/storage/chain-adapter.ts` + `crates/memphis-core`
3. **Nowy tool** → `src/mcp/tools/<name>.ts` + register w `src/gateway/tool-registry.ts`
4. **Security** → `src/security/` + `crates/memphis-vault/`
5. **Provider fix** → `src/providers/{target}/adapter.ts`
6. **Telegram bot** → `src/gateway/channels/telegram.ts` (1000+ LOC, wszystkie handlery inline)
7. **TUI bug** → `crates/memphis-tui/` (Rust) + `src/infra/tui-host/` (TS protocol bridge)
8. **CLI bug** → `src/infra/cli/handlers/` + `src/infra/cli/commands/`
9. **Doctor warn** → `src/infra/cli/utils/doctor-v2.ts` (58 checks, 6 tiers + Tier A architecture)
10. **Cron task** → `~/.memphis/config/scheduler/tasks.json` + `src/infra/runtime/scheduler.ts`

---

## 9. Surfaces & ports

| Surface | Port | Status | Persistence |
|---|---|---|---|
| Memphis daemon HTTP | :3100 | active | systemd `memphis.service` (linger=yes) |
| Ollama | :11434 | active | systemd ollama |
| Piper TTS | :5500 | active | systemd `memphis-piper-tts.service` (mój dzisiejszy add) |
| Whisper STT | :9000 | pending venv | systemd `memphis-whisper-stt.service` (enabled, czeka na operator's `sudo apt python3-venv`) |
| MCP server | :3001 | optional | nieuruchomione (opt-in) |
| Telegram bot | (long polling) | active | gateway in daemon |

---

## 10. Summary

**Memphis = TypeScript orchestration (28 subsystems, 10K gateway LOC) + Rust backbone (9 crates dla crypto, speed, isolation) + 9 append-only chains jako durable memory + 41 MCP tools dla external action.**

Architektura modułowa: voice, media, telegram, TUI to osobne warstwy. Można stawiać po kawałku. Self-modify działa (snapshot + branch + test gate + commit/rollback). Systemd user units + linger=yes zapewniają reboot survival dla daemon + Ollama + Piper.

---

**Last updated:** 2026-05-11.
**Cross-ref:**
- Commit history: `memphis-commit-history-2026-05-11.md`
- Bot self-map: `memphis-self-map-2026-05-11.md`
- Operator setup guide: `../operator/DAILY-ASSISTANT-SETUP.md`
- Agent operational patterns: `agent-operational-patterns-2026-05-10.md`
