# ARCHITECTURE-MAP.md

Real-deal.

## 1) What exists now (live)

### TypeScript shell (active runtime)
- HTTP/API layer
- Provider orchestration
- Config profiles and production safety checks
- Logging, metrics, ops health summary
- Test suite (unit + integration)

### Rust Phase 0 entry (implemented)
- Workspace at repo root (`Cargo.toml`)
- `crates/memphis-core`:
  - block model
  - hash function
  - SOUL validation rules
  - basic chain append/validation path
- `crates/memphis-napi`:
  - minimal exported bridge functions:
    - `chain_validate`
    - `chain_append`
    - `chain_query`
- Contract doc: `docs/NAPI-CONTRACT-V1.md`

### Safety layer for migration
- Feature flag in TS config:
  - `RUST_CHAIN_ENABLED` (default: `false`)
  - `RUST_CHAIN_BRIDGE_PATH`
- Non-breaking fallback to TS legacy path when Rust bridge is unavailable.

---

## 2) What is next (near-term)

### Blueprint Phase 1 focus
- Rust vault track (Argon2id + AES-256-GCM)
- Minimal vault bridge surface via NAPI
- Keep TS runtime stable while introducing Rust-backed secure storage

### Quality expectations
- Keep all quality gates green on every merge:
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `cargo test --workspace`

---

## 3) Current source-of-truth
- Repository path: `/home/memphis_ai_brain_on_chain/memphis-v4`
- Public repo: `https://github.com/Memphis-Chains/memphis-v4`

---

## 4) Guiding rule
- Pro quality over speed.
- No rushed shortcuts.
- Every significant step includes rollback capability.
