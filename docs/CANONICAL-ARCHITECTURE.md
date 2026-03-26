# Memphis Canonical Architecture

Status: proposed source of truth for the current `memphis` repository.

This document defines what Memphis is, what belongs in core, what is extension surface, and what must stay downstream.

It is written against the current local codebase, not historical repo naming or aspirational product language.

For the runtime dependency graph, trust boundaries, and hardening model that this architecture depends on, see `docs/RUNTIME-SECURITY-ARCHITECTURE.md`.

## 1. Product definition

Memphis is a local-first agent runtime with:

- persistent memory,
- operator-controlled tools,
- encrypted vault storage,
- Rust-backed deterministic core primitives,
- TypeScript orchestration, CLI, TUI, HTTP, and MCP surfaces.

Memphis is not:

- a hosted SaaS,
- a document-RAG platform by default,
- a vendor-specific integration bundle,
- a single-channel bot product.

## 2. Primary user outcome

The canonical success path for a new user is:

1. clone repo,
2. bootstrap local environment,
3. initialize vault,
4. start runtime,
5. open TUI or CLI chat,
6. talk to an agent in natural language,
7. have that agent use tools, remember important context, and preserve local operator control.

## 3. System layers

### 3.1 Core runtime

Core runtime is responsible for local execution and public control surfaces.

Includes:

- HTTP server and request policy,
- provider orchestration,
- startup guards and runtime hardening,
- SQLite-backed repositories,
- logging, metrics, and incident surfaces.

Primary paths:

- `src/app/bootstrap.ts`
- `src/infra/http/*`
- `src/modules/orchestration/*` (including `service.ts` with `OrchestrationService`, `chat()`, `generate()`, and provider cooldown/fallback)
- `src/providers/*` (concrete providers: `OllamaProvider`, `MinimaxProvider`, `OpenAICompatibleProvider`, `GlmProvider` via factory + `resolveProvider()`)
- `src/infra/storage/*`

### 3.2 Agent runtime

Agent runtime is responsible for actual conversational behavior.

Includes:

- system prompt,
- tool definitions and execution,
- memory recall and journaling loop,
- channel gateway loop,
- session history behavior.

Primary paths:

- `src/modules/orchestration/service.ts` (`OrchestrationService.chat()` — message-based, tools, system prompt)
- `src/modules/orchestration/task-executor.ts` (task queue generation with input validation)
- `src/gateway/system-prompt.ts`
- `src/gateway/chat-loop.ts`
- `src/gateway/tool-executor.ts`
- `src/gateway/memory-client.ts`
- `src/mcp/tools/*`

**Note:** `src/agent/system.ts` exists as a standalone module for system-level capabilities (shell execution, file operations, app management). It is separate from the gateway-based agent runtime above and is not part of the conversational agent loop.

### 3.3 Operator UX

Operator UX is responsible for making Memphis understandable and configurable.

Includes:

- onboarding wizard,
- setup/configure/bootstrap flows,
- CLI help and command matrix,
- TUI screens and command parity,
- workspace context bootstrapping,
- operator guide.

Primary paths:

- `src/infra/cli/*`
- `src/tui/*`
- `src/modules/workspace/context.ts`
- `src/infra/operator-guide.ts`

### 3.4 Rust deterministic core

Rust owns deterministic, security-sensitive, and performance-sensitive primitives.

Includes:

- chain validation,
- loop engine enforcement,
- embeddings pipeline and persistence,
- vault cryptography,
- block signing support.

Primary paths:

- `crates/memphis-core/*`
- `crates/memphis-embed/*`
- `crates/memphis-vault/*`
- `crates/memphis-napi/*`

### 3.5 Bridge layer

The NAPI bridge is the contract between Rust and TypeScript.

Responsibilities:

- expose stable primitives,
- normalize data envelopes,
- surface bridge health and availability,
- fail to TS fallback only where explicitly allowed.

Primary paths:

- `crates/memphis-napi/src/lib.rs`
- `src/infra/storage/rust-chain-adapter.ts`
- `src/infra/storage/rust-embed-adapter.ts`
- `src/infra/storage/rust-vault-adapter.ts`

### 3.6 Extension surfaces

These are supported extension surfaces, but not core product identity.

Includes:

- MCP server and transports,
- managed apps,
- sync and trade,
- cognitive reports/models,
- downstream channel adapters.

Primary paths:

- `src/mcp/*`
- `src/modules/apps/*`
- `src/sync/*`
- `src/cognitive/*`
- `src/gateway/channels/*`

## 4. State model

Memphis state is split into five domains.

### 4.1 Agent profile

Persistent agent identity and operator configuration.

Required fields:

- agent display name,
- owner display name,
- behavior rules,
- local runtime mode,
- tool policy stance.

Current status:

- partially in `.env`,
- partially absent as a dedicated persistent profile,
- not yet a first-class runtime object.

### 4.2 Session state

Short-horizon conversation history used during active interactions.

Current status:

- gateway has fallback session storage,
- TUI/CLI behavior is not yet unified around one session model.

### 4.3 Durable memory

Durable memory is the combination of:

- journal chains (chain-backed via `storeDurableMemory`),
- decision chains,
- semantic embedding index.

`storeDurableMemory()` in `src/infra/memory/durable-memory.ts` atomically:

1. Appends a block to the chain (audit source of truth)
2. Indexes the content in the Rust embed store via `embedStore()` (recall acceleration)

Tag-based filtering is supported at both the journal append and recall search layers. The embed index is chain-backed: entries reference their source block index and hash via `ChainRef`.

Current rule:

- chain is the audit source of truth,
- embeddings are recall acceleration,
- chain-backed write is the canonical path; direct embedding writes are a lower-level operator/debug surface.

### 4.4 Vault state

Secrets are stored locally and encrypted at rest.

Vault state requires:

- stable pepper,
- valid initialized master material,
- local persistence of the active vault state.

### 4.5 Operational state

Operational state includes:

- task queues,
- health and startup guard state,
- logs and incident bundles,
- managed app registry,
- sync registries.

## 5. Public contracts

### 5.1 CLI contract

CLI is a first-class product surface.

It must support:

- setup/bootstrap,
- onboarding,
- vault management,
- TUI launch,
- memory operations,
- apps,
- sync,
- health and doctor,
- chat/ask workflows.

### 5.2 TUI contract

TUI is the primary local operator console.

It must support:

- natural-language chat,
- memory commands,
- vault commands,
- health/observability,
- runtime guidance,
- tool-aware operation.

### 5.3 HTTP contract

HTTP is for authenticated runtime control and integration.

It must expose only routes that are actually registered by the server.

Documented HTTP routes are valid only if:

- registered in `createHttpServer(...)`,
- covered by auth policy,
- covered by tests.

### 5.4 MCP contract

MCP is an integration surface for tool use and external orchestration.

It is not the primary local user experience, but it is a supported external contract.

### 5.5 NAPI contract

The bridge contract must be treated as stable product infrastructure.

Required properties:

- one normalized shape,
- predictable error envelope,
- explicit fallback rules,
- no silent schema drift between Rust and TypeScript.

## 6. What belongs in core

Belongs in core:

- memory and recall,
- vault,
- agent runtime,
- tool execution,
- HTTP/CLI/TUI/MCP entrypoints,
- Rust primitives and bridge,
- managed app framework,
- operator onboarding and configuration.

Does not belong in core:

- product-specific hotel logic,
- vendor-specific knowledge engines,
- channel-specific packaging,
- downstream workspace notes,
- hardcoded personal identities.

## 7. Downstream model

Downstream integrations should attach through one of:

- managed apps,
- MCP tools,
- HTTP adapters,
- channel adapters,
- external operator/workspace repos.

Examples of downstream concerns:

- OpenClaw integration packs,
- Synjar retrieval adapters,
- vertical products such as HotelAI,
- operator workspace conventions.

## 8. Known architectural gaps

These are current gaps between the codebase and the intended product.

1. ~~Memory HTTP routes exist as a module but are not wired into the main server.~~ — Fixed: `registerMemoryRoutes()` in `src/infra/http/routes/memory.ts` centralizes `/api/journal` and `/api/recall` with security audit logging and chain-backed storage.
2. Gateway has a rich agent prompt, but TUI/CLI chat paths do not share the same runtime model.
3. Agent identity is still env-heavy and product defaults are too personal.
4. ~~Durable memory semantics are split between journal-plus-index and raw embed-store operations.~~ — Fixed: `storeDurableMemory()` atomically chains and indexes; embed writes are chain-backed via `ChainRef`.
5. NAPI bridge contract is effective but still historically layered.
6. Docs are broad but not canonical; historical docs still conflict with current runtime.
7. Chain export CLI is not implemented — only import_json, verify, rebuild exist.
8. ~~Ollama embeddings (TS-layer, dim-768) and Rust LocalDeterministic (in-process, dim-32) have no documented routing relationship.~~ — Fixed: Rust-side network embedding providers (Ollama, OpenAI-compatible, Cohere, Voyage, Jina, Mistral, Together, NVIDIA, MixedBread) are fully supported via `ureq` HTTP client. TS-layer Ollama embeddings removed; all embedding routing is now Rust-native.
9. Cognitive Models A–E implementation status not reflected in canonical docs — all five are fully implemented but this was previously unclear.
10. ~~TUI operator workflow was not documented~~ — Fixed: see `docs/TUI-OPERATOR-GUIDE.md`.
11. ~~Pepper lifecycle is undocumented~~ — Fixed: see `docs/VAULT-PEPPER-LIFECYCLE.md` (partially addressed).
12. Provider system now supports GLM (Zhipu AI) alongside Ollama, Minimax, DeepSeek, and OpenAI-compatible. `OrchestrationService.chat()` provides a message-based API with tools support.
13. Channel gateway (Telegram) is now opt-in via `MEMPHIS_CHANNEL_GATEWAY_ENABLED`.

## 9. Canonical direction

The intended direction is:

- one local-first agent runtime,
- one coherent operator experience,
- one clear memory model,
- one bridge contract,
- extensions and downstream integrations outside of core product identity.

## 10. Architectural decisions for the next sprint

1. ~~Fix the registered public memory contract.~~ — Fixed: `registerMemoryRoutes()` is the canonical registered route.
2. Unify runtime prompt and tool awareness across gateway, CLI, and TUI.
3. Introduce a persistent agent profile instead of env-only identity.
4. ~~Clarify and enforce the difference between chain-backed memory and raw embed debugging.~~ — Fixed: `storeDurableMemory()` is the canonical path; raw embed writes are a debug surface.
5. Stabilize bridge contract and reduce unnecessary legacy dual paths.
6. Collapse docs to a canonical source of truth (in progress).
