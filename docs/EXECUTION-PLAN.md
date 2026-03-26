# Memphis Execution Plan

Status: master canonical roadmap to Memphis `v1.0.0`.

This document is the only approved delivery program for the current repository.

Memphis reaches `v1.0.0` by making the current system internally coherent, security-hardened, and operator-reliable across Rust core, TypeScript runtime, and every supported surface. It does not reach `v1.0.0` by accumulating more providers, more downstream integrations, or more parallel product stories.

## 1. Release Definition

Memphis `v1.0.0` is ready when an operator can:

1. bootstrap and initialize a local runtime safely,
2. initialize and use the vault without secret-handling ambiguity,
3. interact through CLI, TUI, HTTP, MCP, and optional channels without contract drift,
4. rely on chain-backed memory, explainable actions, and bounded self-evolution,
5. trust that prompt injection, unsafe persistence, secret leakage, and surface divergence are actively resisted by the runtime.

## 2. Scope for GA

### In scope

- runtime contract unification,
- vault boundary hardening,
- storage and rollback correctness,
- prompt, persistence, and injection defense,
- self-evolution reliability,
- converged operator surfaces,
- Telegram as a supported optional channel,
- product-aware TypeScript TUI convergence through `6C`,
- release, install, runbook, and docs readiness.

### Explicitly out of scope

- OpenClaw as a required runtime dependency,
- provider expansion beyond the existing set,
- federation or Synjar as a GA dependency,
- Rust TUI replacement,
- downstream product experiments that are not required for runtime correctness.

## 3. Program Rules

These rules stay active for every phase:

- repo docs are canonical product truth,
- workspace planning is execution support, not product truth,
- Rust is authoritative for deterministic and security-sensitive primitives,
- TypeScript is authoritative for orchestration and surface behavior,
- vault is a separate trust boundary,
- append-only memory means unsafe content must be blocked before persistence,
- surfaces may differ in UX, not in capability or policy semantics.

For architecture and runtime trust boundaries, use:

- `docs/CANONICAL-ARCHITECTURE.md`
- `docs/RUNTIME-SECURITY-ARCHITECTURE.md`

## 4. Master Program

The delivery order is fixed. Later phases must not outrun earlier hardening work.

### Phase A. Governance and Canonical Truth

Purpose:

- make one roadmap authoritative,
- remove competing product-truth documents,
- align all docs that define Memphis behavior.

Required outcomes:

- `docs/EXECUTION-PLAN.md` is the single roadmap to `v1.0.0`,
- repo-root roadmap pointers are compatibility stubs only,
- `docs/README.md`, `README.md`, and canonical architecture docs all point to the same product story,
- historical roadmap and sprint material is preserved but visibly superseded.

Done when:

- there is no active roadmap rival inside the repo,
- old sprint docs are traceable through a legacy mapping section instead of acting as live plans.

### Phase B. Runtime Contract Unification

Purpose:

- eliminate divergent execution models across surfaces.

Required work:

- one provider contract,
- one provider resolution path,
- one tool registry plus shared executor path,
- one authorization and approval path,
- one memory and session orchestration model,
- one source of truth for provider/tool capability reporting.

Done when:

- HTTP, CLI, TUI, MCP, and gateway differ only in UX,
- provider and tool behavior is consistent everywhere,
- no runtime path depends on cast hacks, wrapper drift, or surface-specific exceptions.

### Phase C. Vault Boundary Hardening

Purpose:

- treat vault as the highest-sensitivity subsystem.

Required work:

- classify vault actions by sensitivity,
- define explicit policy for listing, reading, bounded use, mutation, and recovery,
- prevent secret material from entering prompt fragments, soul memory, journal, recalled memory, session text, or user output,
- record normalized security events for all vault access and denial paths.

Done when:

- “agent has access” is no longer equivalent to “model may disclose secret values,”
- vault access is bounded, explicit, and auditable,
- secret leakage is blocked structurally, not just by prompt wording.

### Phase D. Storage and Rollback Correctness

Purpose:

- make runtime state and recovery match the real current layout under `~/.memphis`.

Canonical state domains:

- `config/`
- `chains/`
- `vault/`
- `embeddings/`
- `case-index.sqlite` as derived index
- `backups/`

Required work:

- align snapshot and rollback logic to real current artifacts,
- treat chain files as source of truth,
- treat indexes as rebuildable derived state,
- remove legacy `.db` assumptions from current recovery semantics,
- align bootstrap and storage docs with the real layout.

Done when:

- restore matches current runtime behavior,
- derived indexes rebuild deterministically,
- recovery guarantees are true in code and in docs.

### Phase E. Prompt, Persistence, and Injection Defense

Purpose:

- build a real security boundary around model interaction and append-only persistence.

Required work:

- stable system prompt boundary,
- wrapped user and fetched content,
- pre-LLM risk classification,
- pre-persist content scanning for durable writes,
- metadata-only audit for blocked malicious content,
- output guard for protected prompt and secret leakage.

Done when:

- malicious content is blocked before durable write,
- prompt injection is resisted at boundary, policy, and capability layers,
- blocked payloads are not copied raw into append-only memory,
- protected runtime material is not emitted back to the operator unchecked.

### Phase F. Self-Evolution Reliability

Purpose:

- preserve self-modification while making its guarantees real.

Required work:

- route self-modify through shared runtime policy and executor,
- keep passphrase, snapshot, branch isolation, and test gate,
- scan proposed file content before write,
- align rollback semantics with actual runtime storage,
- normalize audit events for approval, block, failure, rollback, and commit.

Done when:

- self-modify is uniformly gated and auditable,
- dangerous file content is blocked before write,
- recovery promises are backed by the real storage model.

### Phase G. Surface Convergence

Purpose:

- make the operator experience coherent across all Memphis surfaces.

Surfaces covered:

- CLI,
- TUI,
- HTTP chat,
- gateway/channels,
- MCP.

Required work:

- ensure all surfaces use the same runtime contracts,
- remove surface-specific tool/provider/auth surprises,
- align help text, command behavior, and operator guidance to actual runtime semantics.

Done when:

- operators can move between surfaces without capability drift,
- surface differences are presentational, not architectural.

### Phase H. GA Product Readiness

Purpose:

- convert the hardened runtime into a release-ready product.

Required work:

- bootstrap and install reliability,
- Telegram hardening as a supported optional channel,
- release gates and reproducible CI signals,
- docs and runbooks consistency,
- smoke and end-to-end operator-path verification.

Channel rule:

- Telegram is in scope for GA as an optional but supported surface.
- Discord may advance in parallel, but it is not a release blocker unless it reaches the same hardening level.

Done when:

- a new operator can install, start, and use Memphis predictably,
- release gates are meaningful and reproducible,
- shipped behavior matches canonical docs.

## 5. TUI Workstream

TUI is a first-class Memphis surface, but it follows runtime correctness instead of outranking it.

Required sequence:

- `TUI 6A` correctness and operator reliability
- `TUI 6B` terminal/runtime extraction and testability
- `TUI 6C` product-aware screen model over the unified runtime
- `TUI 6D` Rust TUI decision gate only after `6A-6C`

`TUI 6C` is part of the GA path.

Its target operator model is:

- `Overview`
- `Chat`
- `Memory`
- `Sessions`
- `Vault`
- `Cases / Decisions`
- `System`

Rules:

- TUI must not invent provider, tool, or auth semantics,
- TUI remains a thin operator surface over the canonical runtime,
- Rust TUI exploration is non-GA and does not block `v1.0.0`.

## 6. Legacy Sprint and Milestone Mapping

Historical sprint material is preserved for auditability, but its active meaning is now defined through this mapping.

| Historical item | Canonical mapping |
| --- | --- |
| Sprint 0 / Truth in Docs | Phase A |
| Sprint 3 hardening | Inputs to Phases B, D, and G |
| Sprint 4 / Doctor v3 | Completed audit baseline for Phases A and B |
| Sprint 17 | Phase H bootstrap/install and Phase G operator readiness |
| Sprint 18 | Phase C vault hardening and Phase H Telegram work |
| Sprint 19 | Phases B, D, and G for memory/session/runtime alignment |
| Sprint 20 | Phase H channel hardening |
| Sprint 21 | Phase F self-evolution reliability |
| Sprint 22 | later runtime partitioning, non-critical unless re-elevated |
| Sprint 23 / federation | downstream, non-GA by default |
| historical M1-M8 roadmap | archived milestone history superseded by this program |

This mapping exists so older notes remain interpretable without acting as parallel planning truth.

## 7. Required End-State Contracts

The `v1.0.0` refactor program converges on these shared contracts:

- `ProviderRuntime`
- `ProviderRegistry`
- `RuntimeTool`
- `ToolExecutionContext`
- `ToolExecutionResult`
- `VaultOperationClass`
- `VaultAccessPolicyResult`
- `PromptAssemblyContext`
- `InputRiskClassification`
- `ContentScanProfile`
- `ContentScanResult`
- `SecurityEvent`
- `RuntimeSnapshotContract`

These contracts do not need to land in one change, but later implementation should not re-open their existence or purpose.

## 8. GA Release Gates

Memphis is not ready for `v1.0.0` until all of the following are true:

- one provider/runtime path is used across surfaces,
- one tool surface and policy model is used across surfaces,
- vault has explicit bounded operation classes,
- blocked malicious content never lands raw in durable memory,
- rollback restores the real runtime layout,
- self-modify is uniformly gated and auditable,
- CLI, HTTP, MCP, gateway, and TUI are semantically aligned,
- Telegram path is hardened enough to be a supported optional channel,
- canonical docs, operator docs, runbooks, and release docs match shipped behavior,
- release gates and smoke paths are reproducible.

## 9. Canonical References

Start with these docs:

- `README.md`
- `docs/README.md`
- `docs/CANONICAL-ARCHITECTURE.md`
- `docs/RUNTIME-SECURITY-ARCHITECTURE.md`
- `docs/EXECUTION-PLAN.md`
- `docs/NAPI-CONTRACT-V1.md`

Historical material remains for auditability, but it is no longer the source of truth for Memphis `v1.0.0`.
