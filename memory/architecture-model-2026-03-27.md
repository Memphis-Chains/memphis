---
name: architecture-model-2026-03-27
description: Memphis architecture snapshot aligned to canonical docs and repo state (2026-03-27)
type: reference
---

# Memphis Architecture Model (2026-03-27)

This is a repo-local summary note. Canonical product truth lives in:

- `docs/CANONICAL-ARCHITECTURE.md`
- `docs/RUNTIME-SECURITY-ARCHITECTURE.md`
- `docs/EXECUTION-PLAN.md`

## Product Shape

Memphis is a local-first agent runtime with:

- persistent memory
- operator-controlled tools
- encrypted vault storage
- Rust-backed deterministic and security-sensitive primitives
- TypeScript orchestration plus CLI, HTTP, MCP, gateway, and support surfaces
- a Rust-native primary operator console

## Layers

```text
Operator surfaces
  - CLI
  - HTTP
  - MCP
  - Rust TUI
  - gateway / optional channels

TypeScript runtime
  - provider selection
  - prompt assembly
  - tool execution and policy resolution
  - HTTP / CLI / MCP / gateway adapters

Rust operator layer
  - memphis-tui -> memphis-operator -> Rust crates
  - native Overview / Chat / Memory / Sessions / Vault / Cases / System flows

Rust deterministic core
  - memphis-core
  - memphis-vault
  - memphis-embed
  - memphis-case-index

Bridge / auxiliary seams
  - memphis-napi for the TypeScript runtime
  - stdio JSON extension host for TS-owned commands from the Rust TUI
```

Important boundaries:

- `memphis-operator` is the accepted native seam for the Rust console.
- `memphis-napi` is not the primary seam for the Rust TUI.
- the extension host is a bounded TUI seam for TS-owned commands, not a global architecture layer
- SQLite is part of the runtime state model, but it is not the only persistence layer; canonical state also lives under `~/.memphis` (`config/`, `chains/`, `vault/`, `embeddings/`, `backups/`) with `case-index.sqlite` as a derived index

## Rust Crates

- `memphis-core` — chain integrity, block/signature primitives, loop engine enforcement, deterministic core behavior
- `memphis-vault` — vault cryptography and encrypted secret storage
- `memphis-embed` — embedding pipeline and embedding persistence
- `memphis-case-index` — case/index querying and derived SQLite-backed indexing support
- `memphis-operator` — native operator runtime, provider status, chat sessions, snapshots, memory/search, vault, and session reads
- `memphis-napi` — Rust <-> TypeScript bridge for the TypeScript runtime
- `memphis-tui` — Rust operator console over `memphis-operator`, plus extension-host client/session management

## Provider Set

Current Rust operator-facing provider set:

- `local-fallback`
- `shared-llm`
- `decentralized-llm`
- `ollama`
- `minimax`
- `deepseek`
- `glm`

This is the current operator/runtime provider set, not a promise that every older abstraction name in the repo is still primary product truth.

## Key Seams And Interfaces

- `ProviderRuntime` in the Rust operator path
- `memphis-tui -> memphis-operator -> Rust crates` for the primary local console
- `memphis-napi` adapters for the TypeScript runtime bridge
- extension-host protocol over stdio with `ready`, `started`, `line`, `result`, `error`, and `cancelled` events
- MCP tool registration with SQLite-backed permission / approval gating

## Entry Points

- TypeScript bootstrap: `src/index.ts` -> `src/app/bootstrap.ts`
- Rust TUI: `crates/memphis-tui/src/main.rs`
- TUI extension host: `src/infra/tui-host/index.ts`
- MCP server: `src/mcp/server.ts`
- NAPI bridge: `crates/memphis-napi/src/lib.rs`

## MCP Tools

Currently registered MCP tools in `src/mcp/server.ts`:

- `memphis_journal`
- `memphis_recall`
- `memphis_search`
- `memphis_decide`
- `memphis_health`
- `memphis_web_fetch`
- `memphis_loop_step`
- `memphis_exec`
- `memphis_case_append`
- `memphis_case_query`
- `memphis_soul_read`
- `memphis_soul_write`
- `memphis_self_modify`

## Dependencies & Packages (zweryfikowane 2026-03-27)

```json
// package.json — 16 wpisów łącznie
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.78.0",
    "@modelcontextprotocol/sdk": "^1.27.1",
    "better-sqlite3": "^12.6.2",
    "chalk": "^5.6.2",
    "cli-progress": "^3.12.0",
    "commander": "^14.0.3",
    "discord.js": "^13.17.1",
    "dotenv": "^17.3.1",
    "fastify": "^5.8.2",
    "grammy": "^1.41.1",
    "pino": "^10.3.1",
    "prompts": "^2.4.2",
    "yaml": "^2.8.2",
    "zod": "^4.3.6"
  },
  "optionalDependencies": {
    "ollama": "^0.5.14"
  },
  "peerDependencies": {
    "ollama": ">=0.5.0"
  }
}
```

### Co było błędne w poprzedniej wiedzy (przed 2026-03-27)

| Pakiet              | Mit                                | Rzeczywistość                                                                        |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `commander`         | CLI parser Memphis                 | CLI ma własny parser w `src/infra/cli/parser.ts`                                     |
| `@anthropic-ai/sdk` | Główny silnik LLM                  | W package.json, ale brak potwierdzonego aktywnego importu w kodzie                   |
| `better-sqlite3`    | Cały stan w jednej SQLite          | Stan rozproszony: `~/.memphis/chains/`, `vault/`, `embeddings/`, `case-index.sqlite` |
| `fastify`           | Tylko `/api/status`, `/api/agents` | Znacznie więcej tras: chat, memory, config, federation, webhooks                     |
| MCP                 | Adapter Telegram/Discord           | MCP = tylko serwer MCP; Telegram i Discord mają dedykowane adaptery                  |
| `ollama` npm        | Główna integracja                  | Integracja przez `runtime.ts` / `check-ollama.js`, nie pakiet npm                    |

### Co się potwierdziło ✅

- `grammy` → adapter Telegram (`telegram.ts`)
- `discord.js` → adapter Discord (`discord.ts`)
- `dotenv` → `env.ts` ładuje `.env`
- `pino` → aktywny logger JSON runtime
- `prompts` → interaktywne pytania przy onboardingu
- `zod` → walidacja schematów (config, HTTP, MCP)
- `fastify` → aktywny HTTP server
- `better-sqlite3` → używany, ale nie jako single source of truth
- `chalk` → kolorowanie CLI outputu
- `cli-progress` → pasek postępu CLI
- `yaml` → konfiguracja

## Pełna zweryfikowana wiedza

**Szczegóły wszystkich warstw → `memory/memphis-knowledge-synth-2026-03-27.md`**

## Podsumowanie zweryfikowanych dependencies (2026-03-27)

**13 faktycznie używanych:** @modelcontextprotocol/sdk, better-sqlite3, chalk, cli-progress, discord.js, dotenv, fastify, grammy, pino, prompts, yaml, zod

**3 NIE używane (ale w package.json):** @anthropic-ai/sdk, commander, ollama npm

## Podsumowanie architektury (7 warstw)

| Warstwa           | Pliki/Moduły                             | Kluczowe                                                    |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------- |
| **Rust TUI**      | memphis-tui                              | 7 ekranów: Overview/Chat/Memory/Sessions/Vault/Cases/System |
| **Rust Operator** | memphis-operator                         | chat, chains, vault, memory, security filtering             |
| **Rust Core**     | core + vault + embed + case-index + napi | 5 crate'ów, każdy osobny zakres                             |
| **TS Runtime**    | providers + channels + tools + prompts   | 7 providerów, DynamicRouter, 13 tools, XML prompts          |
| **TS Infra**      | CLI parser + Fastify + MCP               | 60+ flags, 35+ routes, 15 MCP tools                         |
| **Storage**       | 5 baz SQLite + chains/ JSON              | rozproszone domeny, nie jedna baza                          |
| **Workspace**     | life.db                                  | 31 tabel (projekty/agenci/architektura Memphis)             |

## Accuracy Notes

- This note intentionally uses `Memphis`, not the older `MemphisOS` branding.
- It reflects the shipped Rust-first operator model rather than the earlier migration narrative.
- If this note ever disagrees with the canonical docs, the canonical docs win.
