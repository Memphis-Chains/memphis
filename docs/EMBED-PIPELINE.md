# Embed Pipeline (Phase Increment)

## Scope
`crates/memphis-embed` now provides a working deterministic local embedding pipeline with:
- provider adapter boundary (`EmbeddingProvider` trait)
- default provider: `local-deterministic`
- in-process store + cosine search (`EmbedPipeline`)
- NAPI bridge functions for TS roundtrip (`embed_store`, `embed_search`, `embed_reset`)

## Runtime mode
Current production mode:
- `EmbedMode::LocalDeterministic` ✅

Deferred mode:
- `EmbedMode::Provider(<name>)` returns explicit `ProviderUnavailable` (boundary exists, remote provider not wired yet)

## Limits and safeguards
Defaults:
- embedding dim: `32`
- max input text bytes: `4096`

Validation errors:
- empty input rejected
- oversized text rejected with clear error
- invalid dimension rejected

## TS API path (pragmatic bridge)
Adapter: `src/infra/storage/rust-embed-adapter.ts`

Public calls:
- `embedReset()`
- `embedStore(id, text)`
- `embedSearch(query, topK)`

CLI integration:
- `embed reset`
- `embed store --id <id> --value <text>`
- `embed search --query <text> [--top-k 5]`

## Ops notes
- Requires rust bridge to be enabled (`RUST_CHAIN_ENABLED=true`) and loadable (`RUST_CHAIN_BRIDGE_PATH`)
- Use `memphis-v4 doctor --json` to verify bridge and onboarding status
- Default mode stays in-memory (safe fallback): `RUST_EMBED_PERSIST_ENABLED=false`

### Optional disk-backed persistence (H3.1)
Persistence is behind an explicit env/config boundary and is **opt-in**.

- `RUST_EMBED_PERSIST_ENABLED=true|false` (default: `false`)
- `RUST_EMBED_PERSIST_PATH=/absolute/or/relative/path/index-v1.json`
  - default when enabled: `~/.memphis/embed/index-v1.json`

Load-time compatibility behavior:
- missing file → starts empty (`missing`)
- empty file → starts empty (`empty`)
- corrupt/invalid/unsupported schema → starts empty (`corrupt`)

Runtime behavior:
- `embed store` and `embed reset` persist best-effort to disk when enabled
- failures in disk IO/parse do not crash the bridge; pipeline safely continues in-memory
- `embed_store` response now includes `persistence_enabled` and `persistence_load_state`

## Smoke flow
```bash
RUST_CHAIN_ENABLED=true memphis-v4 embed reset --json
RUST_CHAIN_ENABLED=true memphis-v4 embed store --id doc-1 --value "deterministic local embedding" --json
RUST_CHAIN_ENABLED=true memphis-v4 embed search --query "deterministic" --top-k 3 --json
```
