# Memphis v5 — Architecture Review Report (Pre-v1.0.0)

Date: 2026-03-11  
Scope: full codebase structure review (`src/`, `crates/`, `openclaw-plugin/`) with focus on modularity, patterns, scalability, extensibility, and integrations.

---

## Executive Summary

Memphis v5 has a strong **foundational direction** (clear provider contract, Rust core boundary, repository abstractions, MCP transport support), but it is currently in a **hybrid transition state**: mature pieces coexist with scaffolding and partially integrated subsystems.

For v1.0.0, the main architectural risk is not correctness of individual modules, but **structural drift**:

- mixed layering (CLI types flowing into provider layer),
- duplicated implementations (TS legacy + Rust bridge logic),
- monolithic composition points (`infra/cli/index.ts`, `infra/http/server.ts`),
- and partial integration artifacts (`providers/factory.ts` stub, OpenClaw plugin TODO implementation).

The system can run current workloads, but for **10x scale** it will hit bottlenecks in file-based chain operations, sync protocol payload design, and serial/whole-state operations.

---

## 1) Modularity

## Strengths

- **Core contracts exist** and separate behavior from implementations:
  - `src/core/contracts/llm-provider.ts`
  - `src/core/contracts/repository.ts`
- **Infra adapters are separated** from domain contracts:
  - SQLite repos in `src/infra/storage/sqlite/repositories/*`
  - Rust adapters in `src/infra/storage/*adapter.ts`
- **App composition entrypoint exists** (`src/app/container.ts`) and wires dependencies in one place.

## Weaknesses

1. **Layer boundary leakage (CLI <-> Providers)**
   - `src/providers/ask-orchestrator.ts` imports `ConversationTurn` from `src/cli/ask-session.ts`.
   - `src/providers/context-window.ts` and `src/providers/conversation-history.ts` also depend on CLI type.
   - This reverses expected dependency direction.

2. **Detected circular dependency (real cycle)**
   - Cycle of 4 files:
     - `src/providers/conversation-history.ts`
     - `src/providers/context-window.ts`
     - `src/providers/ask-orchestrator.ts`
     - `src/cli/ask-session.ts`
   - This is a concrete modularity smell and can cause brittle refactors.

3. **God modules**
   - `src/infra/cli/index.ts` (~1925 lines) combines parsing, command routing, runtime orchestration, UX output, and ops logic.
   - `src/infra/http/server.ts` (~318 lines) contains auth, rate-limiting hooks, health, metrics, chat, vault, session, OpenClaw endpoints.

4. **Parallel legacy paths increase coupling**
   - Chain logic exists both in:
     - `src/infra/storage/chain-adapter.ts` (legacy TS fallback),
     - `src/infra/storage/rust-chain-adapter.ts` (NAPI path).
   - Responsibility split is unclear, causing future maintenance overhead.

---

## 2) Design Patterns

## Good patterns in use

- **Repository pattern** for persistence (`SessionRepository`, `GenerationEventRepository`).
- **Adapter pattern** for provider clients and Rust bridge (`SharedLlmProvider`, `DecentralizedLlmProvider`, Rust adapters).
- **Policy object** for provider cooldown (`ProviderPolicy`).
- **Contract-first validation** with Zod (`infra/config/schema.ts`, request/response schemas).

## Missing / underused patterns

1. **Command registry pattern** is missing in CLI
   - Current CLI central switch/router is monolithic; command modules exist but are not the primary dispatch architecture.

2. **Plugin/provider registry pattern is incomplete**
   - `src/providers/factory.ts` is a stub returning `null`.
   - Provider wiring is hardcoded in `src/app/container.ts`.

3. **Ports & Adapters consistency gap**
   - Some areas follow contract boundaries well; others bypass them with direct file/system calls inside operational paths.

## Anti-patterns / inconsistencies

- **Scaffold in production tree**:
  - `openclaw-plugin/src/index.ts` has TODO-heavy placeholder behavior and in-memory chains map with no real loading path.
- **Config inconsistency**:
  - `LOCAL_FALLBACK_ENABLED` exists in schema, but fallback provider is always instantiated in `createAppContainer`.
- **Version inconsistency in runtime status**:
  - package is `0.2.0-beta.1` but `/v1/ops/status` returns `version: '0.1.0'`.

---

## 3) Scalability (10x load assessment)

## Current 10x readiness: **partial / not yet**

### Primary bottlenecks

1. **Chain append/query are whole-state operations**
   - `NapiChainAdapter.appendBlock()` reads entire chain dir, builds full in-memory chain, sends full JSON to `chain_append`, then writes only appended block.
   - Complexity grows with chain length (O(n) per append for read/serialize/validate path).

2. **File-per-block + directory scan strategy**
   - Legacy/adapter paths enumerate block files to determine next index.
   - This will degrade with high block counts and concurrent writers.

3. **Sync protocol pushes full chain sequentially to each agent**
   - `SyncManager.push()` sends all blocks to all agents one-by-one.
   - No chunking, no incremental checkpointing, no parallel fan-out control, no backpressure.

4. **Global mutex in embedding pipeline bridge**
   - Rust NAPI embed pipeline uses `OnceLock<Mutex<EmbedPipeline>>` (single process lock).
   - All embed operations serialize through one mutex; throughput plateaus under concurrency.

5. **SQLite schema lacks critical indexes for growth**
   - `generation_events` queried by `session_id` + `created_at` sorting but no explicit index on these columns.

6. **In-memory process-local controls**
   - Rate limiter/metrics are local in-process; no distributed coordination for multi-instance deployment.

### Secondary limits

- No pagination on some list endpoints by default (`/v1/sessions`, session events).
- MCP HTTP transport keeps session map in memory; no TTL/persistence strategy.

---

## 4) Extensibility

## What is good

- Provider contract is small and extensible (`LLMProvider`: `healthCheck`, `generate`).
- Config schema/profile model is a solid baseline (`envSchema`, profile transforms).
- MCP tool registration is clear and easy to extend (`mcp/server.ts`).

## What blocks extensibility

1. **Hardcoded provider assembly**
   - `createAppContainer` manually constructs provider list from env branches.
   - New provider addition requires touching composition code.

2. **No real plugin runtime**
   - OpenClaw plugin package exists, but implementation is mostly placeholder and disconnected from core runtime adapters.

3. **Feature-flag model is minimal**
   - Mainly boolean env toggles (`RUST_CHAIN_ENABLED`, etc.); no structured feature flag layer (gradual rollout, per-feature gating, kill-switch taxonomy).

4. **Cross-domain file structure overlap**
   - Similar responsibilities exist in `core/`, `decision/`, `cognitive/`, `modules/`, and `providers/` with partial overlap.

---

## 5) Integration Points

## OpenClaw integration

- Positive:
  - HTTP endpoints for journal/recall/decide in `infra/http/server.ts`.
  - MCP server/tools and HTTP/stdio transports implemented.
- Risk:
  - OpenClaw plugin implementation (`openclaw-plugin/src/index.ts`) is not production-grade yet (TODOs, in-memory chains map, no real persistence hooks).

## External APIs

- LLM provider integrations via HTTP clients are clean and typed.
- Error mapping/retry strategy exists in orchestration service.
- Gaps:
  - No circuit breaker beyond cooldown map.
  - No provider-specific concurrency limits.

## Storage backends

- Hybrid stack: SQLite + file-chain + Rust NAPI + vault.
- Good for experimentation, but increases operational complexity and consistency risk.

## Network protocols

- MCP: stdio and HTTP supported.
- Sync: WebSocket request/response envelope implemented, but protocol is coarse-grained (whole chain transfer, no resumable stream/delta paging).

---

## Priority Refactoring Plan for v1.0.0

## P0 (must do before 1.0)

1. **Break CLI-provider cycle and enforce dependency direction**
   - Move `ConversationTurn` to neutral domain types (e.g., `src/core/types/conversation.ts`).
   - Providers/modules may depend on core types, never on CLI layer.

2. **Extract CLI command bus**
   - Split `infra/cli/index.ts` into command registry + individual command handlers.
   - Keep `index.ts` as bootstrap only.

3. **Unify chain append/query architecture**
   - Introduce explicit `ChainStore` port with backends:
     - `FileChainStore` (legacy),
     - `RustChainStore`.
   - Ensure append path does not require full-chain serialization per write.

4. **Harden auth defaults**
   - If running HTTP server outside development, require API token by default (fail-fast startup).
   - Explicitly enumerate auth policy for `/api/journal|recall|decide` routes.

## P1 (high value, near-term)

5. **Add DB indexes + query caps**
   - Index `generation_events(session_id, created_at DESC)`.
   - Add pagination parameters to session/events APIs.

6. **Incremental sync protocol**
   - Extend sync messages with cursor/checkpoint (`fromIndex`/`lastHash`) and chunked transfer.
   - Add conflict metadata and idempotency keys.

7. **Provider factory/registry completion**
   - Replace hardcoded provider construction with declarative registry and capability metadata.

8. **Stabilize OpenClaw plugin**
   - Replace TODO implementation with calls into actual Memphis adapters and persistent storage.

## P2 (post-1.0 hardening)

9. **Introduce feature flag service abstraction**
   - Centralized flags with runtime read and explicit ownership.

10. **Observability upgrade**

- Trace IDs propagated across HTTP/MCP/sync/provider calls.
- Separate saturation/error/latency SLO metrics for each major subsystem.

---

## Architecture Scorecard (pre-v1.0)

- Modularity: **6/10** (good contracts, but cycle + boundary leakage)
- Design consistency: **6/10** (strong patterns mixed with stubs/monolith files)
- Scalability: **5/10** (works now; needs incremental protocols and storage path optimization)
- Extensibility: **6/10** (good interfaces, limited registry/plugin maturity)
- Integration readiness: **7/10** (MCP and API surfaces are broad, but plugin/runtime cohesion incomplete)

**Overall:** **6/10 (promising, but requires structural consolidation before v1.0.0 freeze).**

---

## Key Evidence Files Reviewed

- Composition/runtime: `src/app/container.ts`, `src/app/bootstrap.ts`, `src/infra/http/server.ts`, `src/infra/cli/index.ts`
- Contracts/domain: `src/core/contracts/*`, `src/core/types.ts`, `src/modules/orchestration/service.ts`
- Providers: `src/providers/*`
- Storage: `src/infra/storage/*`, `src/infra/storage/sqlite/*`
- Sync/network: `src/sync/*`, `src/mcp/*`, `src/bridges/*`
- Rust core/bridge: `crates/memphis-napi/src/lib.rs`, `crates/memphis-core/*`, `crates/memphis-embed/*`, `crates/memphis-vault/*`
- OpenClaw plugin: `openclaw-plugin/src/index.ts`

---

If needed, next step can be a concrete **v1.0 architecture migration map** (target package boundaries + file-by-file move plan with zero-downtime sequencing).
