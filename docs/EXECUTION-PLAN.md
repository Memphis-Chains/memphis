# Memphis Execution Plan

Status: canonical roadmap to Memphis `v1.0.0`.

This document is the product source of truth for what must happen between the current repository state and GA. It replaces older mixed roadmap narratives with one sequence aligned to the current codebase, current sprint state, and current documentation governance.

## 1. Governance

Canonical product truth lives in the repository:

- `README.md` - operator entrypoint and product summary
- `docs/CANONICAL-ARCHITECTURE.md` - system boundaries and layer definitions
- `docs/EXECUTION-PLAN.md` - canonical roadmap to `v1.0.0`
- `docs/NAPI-CONTRACT-V1.md` - Rust <-> TypeScript contract
- `docs/API-REFERENCE.md`, `docs/CONFIGURATION.md`, `docs/RELEASE-PROCESS.md` - public/runtime contracts

Operational execution tracking lives in the external workspace layer:

- `../.openclaw/workspace/SPRINT_STATUS.md`
- `../.openclaw/workspace/SPRINT-PLAN-UPDATED.md`
- `../.openclaw/workspace/ROADMAP-COMPLETE.md`
- `../.openclaw/workspace/NEXT_CODER_TASKS.md`

Those workspace files are live planning artifacts, not canonical product truth.

Historical roadmap and review material remains in the repo for auditability, but must be clearly labeled as superseded or historical.

## 2. Goal

Deliver a Memphis `v1.0.0` that a new operator can:

1. clone and bootstrap locally,
2. initialize vault and identity safely,
3. start the runtime without ambiguity,
4. interact through CLI, TUI, HTTP, MCP, and optional channels,
5. rely on durable memory, sessions, and explainable agent behavior,
6. extend the runtime without breaking local-first and auditable guarantees.

## 3. Non-goals for GA

Not required for `v1.0.0`:

- Synjar as a core dependency,
- OpenClaw as a required runtime layer,
- hotel-specific or vertical packaging,
- federation beyond a bounded pilot,
- cosmetic TUI redesign ahead of stable product contracts.

These may continue as downstream or parallel tracks, but they do not define Memphis GA correctness.

## 4. Product Baseline

The current repository already establishes the main Memphis identity:

- local-first agent runtime,
- Rust-backed deterministic core,
- TypeScript orchestration and operator surfaces,
- encrypted vault,
- chain-backed memory,
- session and approval state in SQLite,
- optional channel adapters.

Two clarifications are mandatory for the roadmap:

- `memphis.db` is the canonical Memphis runtime database.
- `life.db` and other workspace databases are operator/workspace planning state, not Memphis runtime state.

Provider baseline must also stay explicit:

- local and cloud providers are part of Memphis proper,
- `minimax`, `glm`, and `deepseek` are Memphis providers, not OpenClaw-only providers.

Integration baseline must stay explicit:

- OpenClaw is an optional integration surface,
- Synjar is an optional downstream retrieval adapter pattern,
- Memphis core must remain correct without either.

## 5. Canonical Sequence To `v1.0.0`

### 0. Documentation and governance cleanup

Before further roadmap work:

- reconcile repo docs and workspace sprint docs,
- define canonical vs operational vs historical sources,
- mark superseded roadmap documents clearly,
- remove doc-level contradictions around TUI, OpenClaw, and downstream integrations.

Done definition:

- a reader can identify the canonical roadmap in one hop,
- older roadmap material is preserved but not misleading,
- repo docs and workspace docs no longer compete for authority.

### 0.5 Security closure gate

Before the main sequence advances:

- verify the security issues claimed fixed in code are actually fixed,
- patch any remaining gaps,
- close the corresponding GitHub issues with evidence,
- record the validated status in the active sprint board.

This is a gate, not optional cleanup. If the issues remain open externally without validated closure, the roadmap remains blocked at the security baseline.

Done definition:

- code and tests support the fix claim,
- GitHub state matches repository reality,
- no known critical security item is left in ambiguous limbo.

### 1. Foundation baseline

Treat Sprint 17 and Sprint 4 work as completed baseline, then reconcile any residue that still affects correctness.

Focus:

- bootstrap and doctor path consistency,
- stale roadmap/doc claims about completed work,
- runtime startup narrative across CLI, TUI, bootstrap, and service flows,
- current architectural contradictions, not feature expansion.

Done definition:

- finished work is reflected accurately in canonical docs,
- no completed sprint remains represented as active unknown work,
- bootstrap, doctor, and runtime docs tell one coherent story.

### 2. Secure runtime baseline

Complete the remaining secure-runtime work from Sprint 18:

- Telegram gateway auto-start behavior,
- vault-backed provider API keys,
- explicit secrets handling and persistence model,
- one operator story for startup, channel enablement, and sensitive config.

Done definition:

- operator no longer relies on plaintext provider keys as the product default,
- channel startup behavior is documented and predictable,
- secret handling is consistent across bootstrap, setup, and runtime docs.

### 3. Memory and session baseline

Complete Sprint 19 and use it to establish canonical memory/session semantics:

- auto-memory injection,
- SQLite-backed session model,
- sessions API,
- one coherent definition of what counts as durable memory vs session context vs debug/operator memory.

This phase is where Memphis becomes a stable long-horizon agent runtime rather than a collection of surfaces around ad hoc memory behavior.

Done definition:

- one session model works across HTTP, gateway, CLI, and TUI,
- memory write and recall semantics are explicit and testable,
- session history is durable and queryable.

### 4. Channel hardening baseline

Complete Sprint 20:

- Telegram allowlist,
- rate limiting,
- Telegram formatting and delivery hardening,
- Discord adapter as an optional channel surface.

Done definition:

- channels are clearly optional,
- channel behavior is production-safe enough for operator use,
- Memphis identity remains broader than any single channel adapter.

### 5. Agent self-evolution baseline

Complete Sprint 21:

- `memphis_self_modify` wiring,
- `memphis_self_learn`,
- `memphis_self_recall`,
- case index and explainability semantics.

This phase is where the agent runtime becomes internally coherent enough for strong memory, case-based reasoning, and audited self-directed behavior.

Done definition:

- self-modification path is wired and gated correctly,
- learn/recall semantics are stable,
- case index behavior is understood as Memphis-local indexed audit state, not a Synjar substitute.

### 6. Per-user runtime baseline

Complete Sprint 22:

- per-user runtime directories,
- per-user memory, chains, and sessions,
- user-scoped case state,
- agent spawning and initial personality/bootstrap model.

Done definition:

- multi-user or multi-agent state is no longer implied by global runtime storage,
- operator can reason clearly about user-scoped vs global state,
- user-aware UX becomes possible without fake placeholders.

### 7. Federation pilot

Treat Sprint 23 and related federation work as a bounded pilot:

- Matrix transport and peer experiments,
- Memphis <-> Synjar or similar peer/service adapters,
- downstream knowledge or multi-node patterns.

Rules:

- federation is parallel unless explicitly promoted,
- Synjar stays optional,
- Memphis GA must not depend on external knowledge-layer availability.

Done definition:

- pilot scope is explicit,
- optional dependencies are labeled as such,
- federation work does not distort the core GA path.

### 8. GA hardening

After the baselines above:

- release-gate stability,
- install and upgrade reliability,
- docs consistency,
- smoke and e2e operator path,
- operational runbook completeness,
- packaging and release verification.

Done definition:

- a new operator can install and run Memphis predictably,
- canonical docs match shipped behavior,
- release gates are green and reproducible.

## 6. TUI Workstream

TUI remains a first-class Memphis surface, but its roadmap must follow product-contract readiness rather than precede it.

### TUI-A. Historical groundwork

Immediate cleanup and refactor groundwork already exists and is tracked separately in `docs/TUI-REFACTOR-PLAN.md`.

This includes:

- split-panel TUI cleanup,
- `ProcessTerminal` and rendering work,
- dead-screen cleanup,
- current testability and snapshot groundwork,
- immediate command/screen hygiene.

TUI-A is not a new roadmap phase. It is prior or near-term groundwork from the Sprint 3/4 context.

### TUI-B. Product-aware redesign

This is the first future TUI milestone and must start only after Sprint 19 through Sprint 21 establish stable contracts for:

- memory,
- sessions,
- channels,
- self-learn and self-recall,
- case index and explainability.

Focus:

- redesign screens around operator jobs, not implementation leftovers,
- remove outdated workflows,
- preserve the current visual direction where it helps continuity,
- avoid locking in UX for features that are not yet stable.

### TUI-C. Per-user console

This phase starts after Sprint 22.

Focus:

- active user context,
- user-scoped memory/session/case views,
- UX that matches per-user runtime reality.

### TUI-D. GA polish

Near GA:

- onboarding/help/runtime guide parity,
- observability polish,
- accessibility and performance checks,
- final screen and workflow trimming.

### Early runtime unification still happens

The current need to unify gateway, TUI, and CLI runtime behavior remains an early requirement. That work belongs in the foundation and memory/session baselines.

Important distinction:

- runtime unification happens early,
- full TUI product redesign happens later.

This resolves the old contradiction between "unify TUI now" and "do not redesign TUI before stable product contracts".

## 7. Cross-cutting Contracts That Must Stay Explicit

### Memory contract

- chain-backed memory is the audit source of truth,
- embeddings and indexes accelerate recall,
- direct low-level storage/debug paths must not be confused with canonical durable memory.

### Session contract

- one durable session model,
- consistent session IDs across surfaces where applicable,
- stable event/history retrieval.

### Secret contract

- operator understands what is reversible, regenerable, and irreversible,
- vault-backed secrets are the preferred path for long-lived sensitive data.

### Integration contract

- OpenClaw is optional,
- Synjar is optional,
- Memphis core correctness cannot depend on downstream integrations.

## 8. `v1.0.0` Done Definition

Memphis `v1.0.0` is ready when all of the following are true:

- canonical docs are coherent and authoritative,
- security closure gate is satisfied,
- secure runtime baseline is complete,
- memory and session semantics are stable,
- optional channels are hardened enough for operator use,
- self-evolution surfaces are wired and explainable,
- per-user runtime semantics are real where promised,
- TUI and CLI reflect actual product workflows rather than placeholder states,
- release gates and install paths are reproducible.

Anything downstream to Synjar, OpenClaw, hotel deployment, or federation may continue after that point, but none of those may silently redefine what counts as Memphis GA.
