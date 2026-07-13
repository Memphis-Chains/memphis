# Memphis Architecture Map

**Current for:** v1.10.0 (2026-07-10)
**Audience:** maintainers, operators, and implementation agents
**Purpose:** a navigation guide to the live repository. It describes the ownership and seams of the codebase; it is not a replacement for detailed design documents.

## 1. System at a glance

Memphis is a local-first agent runtime. TypeScript owns process orchestration, public surfaces, providers, tool execution, and operational policy. Rust owns deterministic and security/performance-sensitive primitives, exposed to TypeScript through N-API.

```text
operator
  ├─ CLI / HTTP / Telegram / native TUI / MCP clients
  │    └─ TypeScript runtime: bootstrap → surface policy → turn runtime
  │          ├─ providers and tool executor
  │          ├─ memory, chains, SQLite, observability, work queue
  │          └─ N-API bridge
  │                └─ Rust: chains, vault, embeddings, paths, TUI support
  └─ operator-local state under the configured Memphis data directory
```

The canonical product/layer definition is [CANONICAL-ARCHITECTURE.md](./CANONICAL-ARCHITECTURE.md). Security and lifecycle details belong in [RUNTIME-SECURITY-ARCHITECTURE.md](./RUNTIME-SECURITY-ARCHITECTURE.md) and [RUNTIME-STATE-MODEL.md](./RUNTIME-STATE-MODEL.md).

## 2. Repository layout

| Area | Role | Notes |
| --- | --- | --- |
| `src/` | TypeScript runtime | Application bootstrap, public surfaces, agent loop, providers, storage, configuration, and policy. |
| `crates/` | Rust workspace | Native primitives and native TUI. Root `Cargo.toml` includes every `crates/*` member. |
| `tests/` | Vitest suites | Unit, integration, CLI, MCP, security, sync, regression, performance, E2E, and ops tests. |
| `scripts/`, `ops/`, `crons/` | Automation | Bootstrap, release gates, drills, maintenance, and scheduled operations. |
| `docs/` | Documentation | `docs/operator/` is operator-facing; `docs/dev/` is design and contributor context. |
| `apps/` | Managed app material | App-specific assets and managed-app integration inputs; runtime app state is separate. |
| `deploy/`, `compose/`, `Dockerfile`, `docker-compose.yml` | Deployment | Container/service definitions and deployment support. |
| `benchmarks/`, `audit/`, `reviews/`, `research/`, `notes/` | Engineering records | Benchmarks, audit material, reviews, research, and local planning notes. |
| `bin/`, `memphis-wrapper.sh` | User entry shims | The npm `memphis` binary resolves into the compiled TypeScript CLI/runtime. |
| `dist/`, `target/`, `node_modules/` | Generated dependencies/artifacts | Build outputs and dependencies; do not treat as source of truth. |
| `.memphis/`, `data/` | Local/runtime material | May be present in a checkout for development, but production state belongs under the configured data directory. |

## 3. Entry points and public surfaces

| Surface | Entry path | Shared runtime seam |
| --- | --- | --- |
| Daemon / HTTP | `src/index.ts` → `src/app/bootstrap.ts` | Bootstrap loads configuration, creates the container, starts HTTP and enabled gateways. |
| CLI | `bin/memphis.js` → `src/infra/cli/index.ts` | Parser and dispatcher route commands to lazy handlers. |
| Conversational gateway | `src/gateway/chat-loop.ts` | Normalizes channel messages, sessions, identity, and calls `turn-runtime.ts`. |
| Telegram | `src/gateway/channels/telegram.ts` | Allowlisted long-polling adapter; text, command, voice, photo, and document inputs feed the gateway. |
| HTTP chat | `src/infra/http/` | HTTP routes pass requests into the same runtime/container policy. |
| MCP | `src/mcp/server.ts`, `src/mcp/transport/` | Stdio and optional HTTP transport expose policy-gated tool contracts. Default HTTP port is 3001. |
| Native TUI | `crates/memphis-tui/`, `src/infra/tui-host/` | Rust terminal client communicates with the TypeScript host protocol. |

`src/app/container.ts` is the primary dependency-composition point: it creates SQLite repositories, provider orchestration, queues, session services, and runtime dependencies. `src/config/paths.ts` delegates canonical data and chain path resolution to the Rust paths bridge so TS and Rust agree on the same state root.

## 4. TypeScript subsystem guide

| Subsystem | Responsibility | Start here when changing… |
| --- | --- | --- |
| `app/` | Process bootstrap and dependency composition | Startup, enabled surfaces, service lifecycle. |
| `gateway/` | Conversation runtime, channel adapters, tools, prompts, media/voice, session identity | Chat behavior, Telegram, tool-loop behavior, or prompt safety. |
| `mcp/` | MCP server, transports, and tool implementations | A new callable capability or MCP contract. |
| `providers/` | Provider adapters, routing, model capabilities, failover | Model/provider selection or completion behavior. |
| `infra/cli/` | Parser, registry, command handlers, doctor, operator CLI | A `memphis` command or setup workflow. |
| `infra/http/` | HTTP server, routes, health, request policy | HTTP API behavior or API health. |
| `infra/storage/` | Chain, vault, SQLite, native bridges, queues, file safety | Durable state, migrations, chain/vault bridge behavior. |
| `infra/runtime/`, `resilience/`, `observability/` | Lifecycle guards, recovery, telemetry, SLOs | Boot/restart behavior, degradation, metrics, or incident evidence. |
| `config/`, `infra/config/`, `security/` | Typed config, mutation/reload, vault references, tiers, safety policy | Configuration, secrets, authorization, or trust boundaries. |
| `cognitive/`, `decision/`, `reflection/`, `trajectory/` | Cognitive modes, derived reasoning passes, decisions, reflections | Cognitive behavior and chain-derived context. |
| `memory/`, `core/`, `soul/`, `kartograf/` | Memory views, chain domain logic, identity, graph/semantic features | Recall, identity, memory semantics, or graph functionality. |
| `modules/`, `backup/`, `sync/`, `federation/`, `bridges/` | Higher-level orchestration and extension features | Apps, backups, distributed/federated behavior, or external bridges. |
| `onboarding/`, `dashboard/`, `agent/` | First-run state, dashboard integration, standalone agent facilities | Initialization or bounded feature-specific flows. |

### Conversational turn flow

```text
surface input
  → channel/HTTP/CLI normalization and session lookup
  → gateway/turn-runtime.ts
  → prompt boundary + surface/tier policy + cognitive/memory prelude
  → selected provider
  → gateway/tool-executor.ts (zero or more policy-gated tool calls)
  → final provider response + anti-confab audit
  → reply delivery, session persistence, journal/cognitive post-pass, telemetry
```

The important source seam is deliberate: surfaces should reuse `turn-runtime.ts` instead of independently implementing provider calls, tool authorization, or persistence behavior.

### Tool and channel conventions

- Put a new local capability in `src/mcp/tools/`, register its schema/metadata in the gateway tool registry, and enforce surface/tier policy through existing registry and executor paths.
- Treat Telegram as a surface adapter, not a second runtime. It supplies identity, session tier override, attachment handling, and delivery; the shared chat loop owns the turn.
- Secrets are vault-managed. Configuration and user-visible setup must not introduce plaintext secret files or bypass vault-reference resolution.

## 5. Rust workspace and bridge

| Crate | Ownership |
| --- | --- |
| `memphis-core` | Chain/block primitives, validation, signatures, deterministic core behavior. |
| `memphis-vault` | Encrypted vault and key material primitives. |
| `memphis-napi` | Stable N-API exports consumed by TypeScript. |
| `memphis-paths` | Canonical data/chain path resolution and normalization. |
| `memphis-embed` | Embedding and semantic-index primitives. |
| `memphis-case-index` | Case/indexing support. |
| `memphis-export` | Export and restoration-oriented formats. |
| `memphis-operator` | Operator-facing native policy/runtime support. |
| `memphis-tui` | Native Ratatui terminal cockpit. |

The TypeScript bridge adapters under `src/infra/storage/` are the compatibility boundary. Change Rust contracts and bridge adapters together, document any fallback behavior, and verify both `npm run test:ts` and `npm run test:rust`.

## 6. Runtime and generated state

The canonical root is `getDataDir()` in `src/config/paths.ts`; it is resolved by `memphis-paths` and may be overridden by supported environment configuration. The usual operator default is `~/.memphis`, not the repository checkout.

| Runtime path/area | Contents | Handling |
| --- | --- | --- |
| `chains/` | Append-only journal, decision, reflection, case, pattern, collective, system, and related chain data | Durable operator state; preserve integrity and backup before repair/migration. |
| `vault/` | Encrypted secrets and vault state | Sensitive; never commit or log plaintext. |
| `config/` | First-run records, identity/soul configuration, scheduler and runtime configuration | Operator-local state; schema changes need migration/compatibility review. |
| SQLite database (`DATABASE_URL`) | Sessions, conversation compaction, permissions, work metadata, and other repositories | Created/migrated by the application container. |
| `embeddings/`, indexes, cache | Derived local retrieval/index artifacts | Rebuildable only where the owning feature explicitly supports it. |
| `apps/`, `skills/`, `state/` | Managed app state, installed skills, attachments, and per-feature state | Local and potentially sensitive; use feature-specific retention controls. |
| `backups/`, `chain-snapshots/`, `logs/` | Recovery artifacts, snapshots, audit/runtime logs | Operational artifacts; maintain with the supplied backup/maintenance commands. |
| `dist/` | TypeScript compiler output | Recreate with the build; never hand-edit. |
| `target/` and native `.node` artifacts | Cargo/N-API build output | Recreate with Rust build scripts; keep platform packaging in sync. |

## 7. Tests, CI, and common change paths

| Change | Minimum navigation and verification |
| --- | --- |
| Gateway or tool loop | `gateway/turn-runtime.ts`, `tool-executor.ts`, tool registry, relevant unit/integration tests; run typecheck, lint, targeted Vitest. |
| Telegram/channel behavior | `gateway/channels/telegram.ts`, chat loop, surface policy, channel tests; cover allowlist, tiers, delivery, and attachment/error paths. |
| New tool | MCP tool implementation, registry, executor, MCP schema/server exposure, surface policy, unit tests. |
| Chain/vault/path behavior | Rust crate plus TS bridge/storage adapter; run TS and Rust suites, and preserve migration/rollback behavior. |
| CLI command | Parser flags, command registry, handler, CLI tests, and operator documentation. |
| Provider behavior | Provider adapter/runtime registry, model capabilities, cascade/orchestration tests. |
| Release/operations | `scripts/`, `ops/`, and relevant workflow in `.github/workflows/`; retain machine-readable outputs expected by release gates. |

The test hierarchy is intentionally broad: `tests/unit/` is the fast behavioral suite; `tests/integration/`, `tests/mcp/`, `tests/security/`, `tests/sync/`, `tests/regression/`, `tests/performance/`, `tests/e2e/`, and `tests/ops/` verify cross-boundary contracts. GitHub Actions includes CI, release, offline acceptance, native prebuild, Telegram smoke, recovery-drill, and scheduled quality workflows.

## 8. Maintainer rules of thumb

1. Reuse shared runtime seams before adding a surface-specific implementation.
2. Keep deterministic, security-sensitive, or performance-critical primitives behind the Rust/bridge boundary where appropriate.
3. Treat chain and vault changes as migration work: preserve compatibility, integrity, and recovery paths.
4. Keep secrets in the vault and use typed configuration/approved mutation paths.
5. Update the closest operator/developer contract and tests with behavior changes; generated output is never the canonical patch target.

## Related references

- [Canonical Architecture](./CANONICAL-ARCHITECTURE.md)
- [Runtime Security Architecture](./RUNTIME-SECURITY-ARCHITECTURE.md)
- [Runtime State Model](./RUNTIME-STATE-MODEL.md)
- [Testing and Verification](./TESTING-VERIFICATION.md)
- [N-API Contract](./NAPI-CONTRACT-V1.md)
- [Developer Guide](./DEVELOPER.md)
