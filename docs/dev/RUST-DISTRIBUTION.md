# Rust NAPI distribution

This doc covers how the Rust-side of Memphis (vault encryption, chain
hashing, embeddings, case index) ships to npm-installing operators.

## Architecture

The Rust workspace lives under `crates/`. The `memphis-napi` crate
exports a Node-N-API surface (`crate-type = ["cdylib"]`) that the TS
layer loads via `createRequire(...)`. The bridge module exposes
~17 functions covering vault, chain, embed, and case-index ops.

### Two distribution paths

Operators get the bridge via one of:

1. **Prebuilt platform sub-package** (preferred). Per-platform npm
   sub-packages under `crates/memphis-napi/npm/<triple>/` ship just
   the matching `index.node`. Root `package.json:optionalDependencies`
   lists all four; npm picks the right one via `os`/`cpu`/`libc` keys.
   This is the S9-1+S9-3 architecture.

2. **Build from source** (fallback). When no platform sub-package is
   installable (musl Linux, exotic arch, `--no-optional` install,
   pre-publish source checkout), the postinstall script triggers
   `npm run build:rust:release` and the resulting in-tree
   `crates/memphis-napi/index.node` is loaded by `loadBridgeModule`.

### Resolver flow

`src/infra/storage/napi-contract.ts:loadPlatformAwareBridge` runs:

```
detect platform triple  → detectPlatformTriple(process)
                        ↓
try platform sub-package → require('@memphis-chains/memphis-<triple>')
                        ↓ (caught)
fall back to in-tree    → loadBridgeModule(<inTreePath>)
                        ↓ (returns BridgeModule | null)
contract resolution     → resolveBridgeContract(bridge, aliases)
```

The in-tree path is produced by `resolveRustBridgePath` in
`src/infra/runtime/install-root.ts` (anchors on installRoot, allows
`RUST_CHAIN_BRIDGE_PATH` env override).

## Supported platforms

| Triple | Tested in CI | Notes |
|--------|--------------|-------|
| `linux-x64-gnu` | ✅ | Primary target — most operator desktops + AWS x86 |
| `linux-arm64-gnu` | ✅ (post S9-3) | Raspberry Pi 4 64-bit, AWS Graviton |
| `darwin-x64` | ✅ (post S9-3) | macOS Intel |
| `darwin-arm64` | ✅ (post S9-3) | macOS Apple Silicon (M1+) |
| `linux-x64-musl` | ❌ | Alpine — build from source |
| `win32-x64` | ❌ | Memphis rejects Windows native; use WSL2 |

Adding a new triple = add `crates/memphis-napi/npm/<triple>/package.json`
+ extend `detectPlatformTriple` + extend the prebuilds.yml matrix.

## Migration plan

| Phase | What | When |
|-------|------|------|
| **S9-0** ✅ | npm tarball ships in-tree binary; postinstall probe + glibc/musl detection | shipped 2026-05-02 (#390) |
| **S9-1a** ✅ | Platform-aware resolver + sub-package skeletons (no publishing) | shipped (#401) |
| **S9-1b** | Add `optionalDependencies` to root `package.json` after sub-packages exist on registry | follow-up |
| **S9-2** | Drop in-tree `index.node` from npm tarball `files[]` (only platform sub-packages ship binaries) | follow-up |
| **S9-3** ✅ | `prebuilds.yml` workflow: 4-platform matrix builds + publishes each sub-package | this PR |
| **S9-4** | `postinstall-fetch-native.mjs` — fallback download from GH Release for offline/firewalled installs | follow-up |
| **S9-5** | SHA256SUMS + Sigstore attestations per prebuild | partial via S8-1; full extension follow-up |

The order matters: **S9-1a** establishes the resolver shape so the
runtime can find platform sub-packages once they exist. **S9-3**
publishes them. **S9-1b** then adds `optionalDependencies` so npm
auto-installs the matching one. **S9-2** drops the in-tree binary
from the main tarball (last to land — the in-tree fallback stays
working until per-platform publishing is proven).

## Why napi-rs CLI not adopted

The plan originally considered `@napi-rs/cli` adoption (replacing
`cargo build` with `napi build --release --platform`). On closer
read this is unnecessary churn:

- `napi-derive 3` (already in `Cargo.toml`) generates the JS bindings.
- The cdylib output from `cargo build` is exactly what we need.
- `napi build` mostly handles cross-compilation orchestration —
  GitHub Actions does that fine via per-platform matrix runners.

The sub-package layout copies the `@napi-rs/cli` convention without
inheriting the build tool. Lower migration risk; same operator-
facing experience.

## See also

- `src/infra/storage/napi-contract.ts` — bridge contract + loader
- `src/infra/runtime/install-root.ts` — install-root + env override
  resolution for the in-tree path
- `crates/memphis-napi/npm/README.md` — sub-package layout reference
- `scripts/postinstall-check-native.mjs` — postinstall probe (S9-0)
- `docs/operator/CLEAN-INSTALL.md` — operator-side install walkthrough
- `docs/dev/RELEASE-PROCESS.md` — GPG signing for release artifacts
