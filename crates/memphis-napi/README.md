# memphis-napi

The TypeScript ↔ Rust bridge. Exposes `memphis-core`, `memphis-vault`, `memphis-embed` to the Node.js runtime via N-API.

## Public surface

NAPI exports (consumed from `src/infra/storage/rust-*-adapter.ts`):

- Chain: `chain_init`, `chain_append_strict`, `chain_append_precomputed`, `chain_validate`, `chain_query_blocks`
- Vault: `vault_*` (encrypt, decrypt, list, rotate)
- Embed: `embed_store`, `embed_search`, `embed_rebuild`
- Cases: `case_*` index ops
- Harness: replay primitives

The pre-built native module is committed at `index.node` so `npm install` works without a Rust toolchain on consumer machines. Rebuild with:

```bash
npm run build:napi      # or: cargo build -p memphis-napi --release
```

## Build

```bash
cargo build -p memphis-napi
cargo check -p memphis-napi
```

## Layer

L2 bridge. Pure plumbing — no business logic lives here, only NAPI argument marshalling and error translation between Rust `Result` and JS exceptions.

## Stability contract

NAPI surface is documented in `docs/dev/NAPI-CONTRACT-V1.md`. Breaking changes require a major version bump on the npm package.
