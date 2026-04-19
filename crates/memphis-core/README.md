# memphis-core

Chain integrity, block hashing, ed25519 signing/verification. The bedrock crate — every signed block in Memphis travels through here.

## Public surface

- `chain.rs` — append-only chain primitives (`append_strict`, `append_precomputed`)
- `block.rs` — block schema + serde
- `hash.rs` — SHA-256 hashing of blocks (deterministic by content)
- `signature.rs` — ed25519 sign/verify, signer allowlist
- `harness.rs` — replay harness for test fixtures
- `loop_engine.rs` — bounded loop primitive (max-tool-calls enforcement)

## Build

```bash
cargo build -p memphis-core
cargo test -p memphis-core --lib
```

Sanitizers (Phase A3, weekly CI):

```bash
cargo +nightly test -p memphis-core --lib -Z sanitizer=address
cargo +nightly test -p memphis-core --lib -Z sanitizer=undefined
cargo +nightly test -p memphis-core --lib -Z sanitizer=thread
```

## Layer

L1 (Storage) primitives. Used by `memphis-napi` to expose chain operations to the TS runtime, by `memphis-vault` for signing vault state changes, and by `memphis-case-index` for case-block validation.

## Stability

Stable since v1.0.0. Block schema is forwards-compatible (additive fields only). Signature primitive is `ed25519`; post-quantum migration would be a separate major version.
