# BLUEPRINT-GAP-ANALYSIS.md — memphis-v4

Real-deal.

## Scope
Comparison between current `memphis-v4` state and target architecture from BLUEPRINT (Rust core + napi bridge + TS shell + TUI/MCP trajectory).

## Current baseline (as of this analysis)
- Published baseline release: `v0.1.0`
- Active branch includes reliability docs/process hardening
- Source-of-truth repo path: `/home/memphis_ai_brain_on_chain/memphis-v4`

## Gap matrix (Blueprint vs Current)

| Area | Blueprint target | Current state | Gap level | Risk if delayed | Proposed order |
|---|---|---|---|---|---|
| Rust workspace | `Cargo.toml` workspace + `crates/*` | Not present in active repo | High | TS-only core persists; no sovereign chain boundary | 1 |
| Rust chain core | `memphis-core` block/chain/soul/query | Not present in active repo | High | Integrity model remains outside Rust | 2 |
| NAPI bridge | `memphis-napi` with `chain_append/validate/query` | Not present | High | No stable TS↔Rust contract | 3 |
| TS wrapper to Rust | Chain operations routed via NAPI | Not present | High | Cannot pass Phase 0 gate | 4 |
| Vault Rust crate | `memphis-vault` Argon2id + AES-256-GCM | Not present | High | Phase 1 cannot start safely | 5 |
| TUI Nexus | `src/tui/*` | Present (minimum shell + command parity adapters, screen entrypoint) | Low | full UX polish still pending | 7 |
| MCP bridge layer | `src/bridges/*` | Not present in target shape | Medium | Tool ecosystem delayed | 8 |
| Decision/intelligence full port shape | `src/decision/*` + `src/intelligence/*` in blueprint layout | Partially present in other legacy contexts, not aligned here | Medium | roadmap fragmentation | 6 |

## What is already useful (keep)
- TS shell foundation (`src/`, tests, scripts)
- quality/release process discipline
- provider/config/gateway baseline already production-minded
- documentation and changelog structure

## What must not be rushed
- Rust core and napi boundaries (contract mistakes here create long-term debt)
- Vault cryptography API surface (must be minimal, test-first)
- migration path from current TS memory representation to Rust-backed chain

## First safe implementation slice (P0 for v0.2.0 start)

### Slice S1 — Rust workspace + memphis-core skeleton + tests
Deliverables:
- root `Cargo.toml` workspace
- `crates/memphis-core/` with:
  - `block.rs`
  - `hash.rs`
  - `soul.rs`
  - `chain.rs` (minimal append + validate path)
  - `lib.rs`, `error.rs`
- `cargo test --workspace` green for core primitives

DoD:
- deterministic block hash test
- chain link validation test
- genesis rule test

Rollback:
- remove Rust additions from main via revert commit (no TS behavior change yet)

### Slice S2 — memphis-napi minimal bridge
Deliverables:
- `crates/memphis-napi/` with minimal exported functions:
  - `chain_append`
  - `chain_validate`
  - `chain_query`
- build script and docs for local build

DoD:
- TS can call at least one bridge function in a smoke test

Rollback:
- fallback to current TS path, keep Rust crates isolated

### Slice S3 — TS wrapper integration flag (non-breaking)
Deliverables:
- chain adapter in TS with feature flag (`RUST_CHAIN_ENABLED=false` default)
- smoke tests for both paths (TS legacy + Rust path)

DoD:
- no regression with flag off
- basic append/query works with flag on

Rollback:
- set flag off globally

## Execution order (recommended)
1. S1 (workspace + memphis-core)
2. S2 (napi minimal bridge)
3. S3 (TS wrapper + feature flag)
4. Then open Phase 1 vault track

## Decision checkpoints
- Gate A: Rust core tests stable for 2 consecutive runs
- Gate B: NAPI smoke stable on local environment
- Gate C: TS wrapper passes tests both flag modes

## Next action
Create `ROADMAP-V0.2.0-BLUEPRINT-P0.md` with task-level ownership, KPI, risk, rollback per slice.
