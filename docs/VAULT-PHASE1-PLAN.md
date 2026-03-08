# VAULT-PHASE1-PLAN.md

Real-deal.

## Goal
Start Blueprint Phase 1 safely: Rust vault foundation with clear crypto boundaries and rollback-friendly slices.

## Scope (Phase 1 start)
- New crate: `crates/memphis-vault`
- Minimal API surface (no overbuild):
  - key derivation scaffold (Argon2id-ready)
  - encrypt/decrypt interface scaffold (AES-256-GCM-ready)
  - init flow contract (input/output model)
- No TS runtime breakage

## Slices

### S1 — Crate bootstrap
- Create `memphis-vault` crate structure
- Add error types + public module exports
- Add compile-only smoke test

### S2 — API contracts
- Define stable Rust types for:
  - `VaultInitRequest`
  - `VaultInitResult`
  - `VaultEntry`
- Add serde-compatible serialization tests

### S3 — Crypto boundary stubs
- Add stubs for:
  - `derive_master_key(...)`
  - `encrypt_entry(...)`
  - `decrypt_entry(...)`
- Add TODO-guarded tests (expected failure until implementation)

## Quality gates
- `cargo test --workspace`
- `npm run lint && npm run typecheck && npm test && npm run build`

## Rollback
- Revert Phase 1 bootstrap commits (crate is isolated; TS path unaffected)

## Non-goals (for this kickoff)
- Full production cryptography implementation
- NAPI integration for vault in same PR
- Full onboarding wiring
