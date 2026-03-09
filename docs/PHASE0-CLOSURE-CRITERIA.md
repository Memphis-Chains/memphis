# Phase 0 closure criteria (exact)

Phase 0 is closed only when all items below are true:

- [x] Rust workspace baseline present and green (`cargo check --workspace`)
- [x] Core + NAPI crates wired in workspace
- [x] Missing embed crate added: `crates/memphis-embed` (skeleton + deterministic tests)
- [x] Deterministic combined build path exists:
  - `npm run build:rust`
  - `npm run build` executes Rust + TypeScript build in order
- [x] Minimal chain migration command exists and is functional:
  - `chain import_json --file <path>`
  - validates basic chain linkage/index rules
- [x] Global quality gate green (`lint`, `typecheck`, `test`, `build`, `cargo test --workspace`)

Notes:
- Phase 1 vault cryptography depth remains separate from this closure gate.
- Vault CLI and provider-key path validation are tracked as Phase 1 critical slice.
