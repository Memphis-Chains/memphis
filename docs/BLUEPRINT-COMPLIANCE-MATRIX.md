# BLUEPRINT COMPLIANCE MATRIX

Date: 2026-03-09
Scope: `MEMPHIS v4 — CODELINE & BUILDER'S BLUEPRINT` (2026-03-08)
Mode: production-only, evidence-first

## Status Legend
- PASS — implemented and operationally validated
- PARTIAL — implemented in meaningful scope, but blueprint gate not fully closed
- MISSING — not implemented in blueprint-required scope

---

## 1) Architecture Overview

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Rust core for chain/vault/embed + TS shell boundary | PASS | NAPI boundary active, Rust tests and TS tests passing in quality gates | Maintain boundary in review checklist |
| MCP layer as first-class bridge surface | PARTIAL | Bridge scaffolding exists, but full MCP serving/consuming gate not closed | Deliver MCP E2E proof with external agent |

## 2) Codeline & Directory Intent

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Core structure (crates + src + scripts + docs + tests) | PASS | Structure aligns with practical blueprint execution | Keep docs index synced with actual tree |
| Full one-to-one parity with aspirational tree | PARTIAL | Some paths evolved pragmatically vs blueprint sketch | Add codeline map doc: actual vs target path mapping |

## 3) Rust Core Spec

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Chain/Vault/Embed crates + tests + bridge | PASS | cargo tests green, bridge APIs used by TS flows | Add explicit compatibility contract doc for bridge APIs |
| Export/import migration completeness evidence | PARTIAL | Import paths and guarded writes exist; final migration evidence pack missing | Add migration evidence doc with before/after sample hashes |

## 4) Vault & SSI

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Vault init/add/get/list operational + guarded onboarding | PASS | Onboarding/bootstrap hardened with retries, guards, recovery hints | Add key-rotation mini-runbook |
| SSI credential issuance/verification full scope | MISSING | Not yet delivered as full feature gate | Implement SSI issue/verify MVP command path |

## 5) TUI Nexus

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Full-screen TUI, keybinds, streaming, health/obs | PASS | UX and observability stabilized, persistence + export/reset present | Add single TUI E2E smoke matrix doc |
| Full blueprint screen set parity (all target screens fully featured) | PARTIAL | Core screens exist; some advanced views still simplified | Add Decision-rich screen parity iteration |

## 6) LLM Provider System

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Provider orchestration + fallback + health | PASS | Stable in CI + smoke workflows | Keep provider SLA checks in runtime pack |
| Provider lifecycle UX parity (`add/list/test` full target) | PARTIAL | Core behavior exists, full UX parity still incremental | Add consolidated provider command acceptance tests |

## 7) Install & Onboarding

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Scripted install + wizard/bootstrap + doctor/smoke | PASS | `install`, `bootstrap`, `doctor`, smoke pack and runbook in place | Add fresh-host reproducibility report |
| Blueprint gate: non-author installs in 5 minutes (external proof) | PARTIAL | Tooling ready, external proof record not yet attached | Run and record one external dry install proof |

## 8) Salvage / Drop / Rewrite Strategy

| Area | Status | Notes | Next task to close |
|---|---|---|---|
| Practical salvage/refactor execution | PASS | Existing code has been continuously aligned to blueprint execution needs | Keep changelog mapping to blueprint sections |
| Formal salvage map closure (explicit file-by-file matrix) | PARTIAL | Partially documented, not yet fully consolidated | Publish one canonical salvage/drop/rewrite matrix table |

## 9) Phased Roadmap (0–8)

| Phase | Status | Notes | Next task to close |
|---|---|---|---|
| Phase 0 Foundation | PASS | Build/test foundation and Rust/TS bridge operational | Maintain regression baseline |
| Phase 1 Vault | PASS | Vault flow stable + validated | Add rotation checklist |
| Phase 2 Providers + Ask | PASS | Ask/provider flow operational | Extend acceptance matrix across provider modes |
| Phase 3 TUI Nexus | PASS | Core TUI flow delivered and hardened | Maintain UX smoke coverage |
| Phase 4 Onboarding | PASS | Onboarding/bootstrap path hardened | Add external install evidence |
| Phase 5 Decision + Intelligence | PARTIAL | Minimal gate now proven (`decide/infer` + lifecycle transition + smoke + evidence), but persistence/audit trail still pending | Add decision transition persistence and audit chain refs |
| Phase 6 Advanced Features | PARTIAL | MCP-style E2E smoke and hard gate delivered with strict assertions and artifacts; native bridge endpoint path still pending | Replace simulation wrapper with native MCP transport invocation |
| Phase 7 Polish + Distribute | PARTIAL | Strong CI/docs/ops polish; full distribution gate not fully proven | Add external user install/use evidence pack |
| Phase 8 Sovereignty Features | PARTIAL | Minimum sovereignty hard gate delivered (signed proof + two-node sync proof + validators + combined hard smoke) | Replace simulated cryptographic/sync internals with native implementations |

---

## Final Assessment

- Practical implementation maturity: **high** in production hardening and operational reliability.
- Full blueprint compliance maturity: **partial** — strongest in phases 0–4, incomplete in 5–8 sovereignty/composability gates.

## Priority Order for Final Closure

1. Phase 5 persistence/audit trail for lifecycle transitions
2. Phase 6 native MCP bridge endpoint invocation (replace simulation wrapper)
3. Phase 8 native cryptographic signing + real transport sync (replace simulation internals)
