# Memphis Execution Plan

Status: canonical roadmap to Memphis `v1.0.0`.

This document defines the only approved path to GA for the current repository.

Memphis does not reach `v1.0.0` by adding more surfaces, more providers, or more downstream integrations. It reaches `v1.0.0` by making the current system internally coherent, security-hardened, and consistent across Rust core, TypeScript runtime, and every operator surface.

## 1. Canonical Goal

Deliver a Memphis `v1.0.0` that an operator can:

1. bootstrap locally,
2. initialize identity and vault safely,
3. start the runtime without contradictory behavior across surfaces,
4. interact through CLI, TUI, HTTP, MCP, and optional channels with the same core semantics,
5. rely on durable memory, explainable actions, and auditable self-evolution,
6. trust that prompt injection, secret leakage, and contract drift are actively resisted by the runtime.

## 2. Non-goals for GA

Not required for `v1.0.0`:

- OpenClaw as a required runtime layer,
- new LLM/provider expansion,
- federation as a GA dependency,
- downstream retrieval systems such as Synjar as core infrastructure,
- cosmetic TUI redesign ahead of runtime correctness.

These may continue downstream, but they do not define Memphis GA correctness.

## 3. Canonical Runtime Truth

The runtime is authoritative only when these boundaries are explicit:

- Rust core is authoritative for chain integrity, vault cryptography, loop limits, and deterministic storage/index operations.
- TypeScript runtime is authoritative for orchestration, prompt assembly, policy resolution, tool routing, sessions, and operator surfaces.
- Vault is a separate trust boundary, not just another tool.
- Append-only memory means unsafe content must be blocked before persistence.
- MCP, gateway, HTTP, CLI, and TUI must not silently drift into different products.

This architecture is described in:

- `docs/CANONICAL-ARCHITECTURE.md`
- `docs/RUNTIME-SECURITY-ARCHITECTURE.md`

## 4. Current Priority Order

Memphis `v1.0.0` now follows this hardening-first sequence.

### Phase 0. Canonical documentation and governance

Before more feature work:

- keep repo docs as canonical product truth,
- keep workspace docs as operational planning only,
- mark historical roadmap material clearly,
- align architecture, soul, security, TUI, and release docs to actual code.

Done definition:

- one canonical roadmap,
- one canonical runtime architecture story,
- no contradictory “product truth” documents remain active.

### Phase 1. Runtime contract unification

Unify the execution model across all surfaces:

- one provider contract,
- one provider resolution path,
- one tool registry and shared executor path,
- one authorization and approval path,
- one session and memory orchestration model.

Primary targets:

- provider drift between orchestration, gateway, and HTTP,
- tool-surface drift between MCP and in-process runtime,
- runtime behavior drift between HTTP, gateway, CLI, and TUI.

Done definition:

- surfaces differ only in UX, not in accidental capability,
- provider and tool behavior are consistent everywhere,
- runtime no longer relies on hidden wrapper/cast assumptions.

### Phase 2. Vault boundary hardening

Treat vault as the highest-sensitivity subsystem.

Required work:

- classify vault operations by sensitivity,
- define explicit policy for listing, reading, using, mutating, and recovering vault state,
- ensure secret material never leaks into prompt fragments, soul memory, journal, or user output,
- audit every vault access through normalized security events.

Done definition:

- “the agent has the keys” is no longer equivalent to “the model may reveal anything,”
- vault usage is bounded by runtime policy and auditable semantics,
- secret material cannot flow into durable memory by accident.

### Phase 3. Storage and rollback correctness

Normalize the runtime state model around the actual `~/.memphis` layout:

- `config/`
- `chains/`
- `vault/`
- `embeddings/`
- `case-index.sqlite` as derived index
- `backups/`

Required work:

- make snapshot/rollback match the real storage layout,
- treat derived indexes as rebuildable,
- remove legacy `.db` assumptions from current recovery logic,
- align soul/bootstrap/storage documentation with real path resolution.

Done definition:

- rollback restores current runtime state correctly,
- derived indexes rebuild deterministically,
- docs match code for runtime storage semantics.

### Phase 4. Prompt and persistence security

Build a real security boundary around model interaction and append-only persistence.

Required work:

- immutable system prompt with explicit trust boundaries,
- wrapped user input and wrapped fetched content,
- input risk classification before model execution,
- pre-persist content scan for append-only and long-lived writes,
- metadata-only audit for blocked malicious content,
- output guard for protected prompt and secret leakage.

Done definition:

- malicious content is blocked before durable write,
- prompt injection is resisted at boundary, policy, and tool layers,
- blocked payloads are not copied raw into append-only memory,
- output leakage of protected runtime material is guarded and audited.

### Phase 5. Self-evolution reliability

Keep self-modification, but make it structurally correct.

Required work:

- keep passphrase, snapshot, branch isolation, and test gate,
- route self-modify through the shared executor and policy layer,
- scan proposed file content before write,
- ensure rollback semantics match real current storage,
- normalize audit events for commit, block, failure, and rollback.

Done definition:

- self-modification is uniformly gated and auditable,
- dangerous file content is blocked before write,
- recovery guarantees are aligned to actual runtime state.

### Phase 6. Operator surface convergence

Converge the operator-facing runtime:

- CLI,
- TUI,
- HTTP chat,
- gateway/channels,
- MCP.

Required work:

- surfaces use the same runtime contracts,
- TUI command set and prompt/runtime semantics match reality,
- docs and operator guidance reflect the actual unified surface.

Done definition:

- operator can move between surfaces without capability surprises,
- TUI/CLI/gateway are different interfaces to the same runtime,
- no surface remains “special” only because it uses a different execution path.

### Phase 7. GA hardening and release readiness

After the runtime is coherent:

- final release gates,
- install and upgrade reliability,
- smoke and end-to-end operator path,
- docs consistency,
- runbooks and operational readiness.

Done definition:

- a new operator can install and run Memphis predictably,
- canonical docs match shipped behavior,
- release gates are reproducible and meaningful.

## 5. TUI Placement

TUI remains a first-class Memphis surface, but it follows runtime correctness.

Immediate rule:

- continue TUI cleanup and testability work only when it preserves the unified runtime contracts.

Active phased sequence after runtime hardening:

- `TUI Phase 6A` — correctness and operator reliability in the current TypeScript TUI:
  - scroll bounds,
  - dashboard scrolling,
  - resize-safe split layout,
  - correct redraw behavior.
- `TUI Phase 6B` — terminal/runtime extraction:
  - explicit terminal I/O seams,
  - fake-terminal testing,
  - command dispatch separated from the readline loop.
- `TUI Phase 6C` — product-aware screen model:
  - rebuild the TUI around real operator jobs and canonical Memphis runtime data.
- `TUI Phase 6D` — Rust TUI decision gate:
  - a bounded spike for a separate Rust binary only after 6A-6C are complete and stable.

Do not:

- redesign TUI around placeholder screens,
- let TUI invent provider or tool semantics that differ from the rest of the runtime,
- treat TUI polish or rewrite work as higher priority than provider/tool/auth/storage correctness.

## 6. Security Gate for Ongoing Work

No roadmap phase may bypass these standing rules:

- no new provider expansion before provider contract unification,
- no new downstream integrations before core runtime coherence,
- no new memory-like persistence path without pre-persist content scanning,
- no new secret-handling path outside the vault boundary model,
- no new operator surface behavior that diverges from canonical runtime contracts.

## 7. Canonical References

Use these docs first:

- `README.md`
- `docs/README.md`
- `docs/CANONICAL-ARCHITECTURE.md`
- `docs/RUNTIME-SECURITY-ARCHITECTURE.md`
- `docs/EXECUTION-PLAN.md`
- `docs/NAPI-CONTRACT-V1.md`

Historical material remains for auditability, but it is not the source of truth for Memphis `v1.0.0`.
