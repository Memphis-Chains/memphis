# Per-platform NAPI sub-packages

Each directory here is a npm sub-package that ships the prebuilt
NAPI bridge binary (`index.node`) for one platform/arch/libc triple.
Operators on supported platforms get the matching binary via npm's
`optionalDependencies` resolution against `os` / `cpu` / `libc`
keys in each sub-package's `package.json`.

## Layout

```
crates/memphis-napi/npm/
├── linux-x64-gnu/      # Linux x86_64 with glibc (most desktops + ubuntu)
│   └── package.json
├── linux-arm64-gnu/    # Linux aarch64 with glibc (Raspberry Pi 4 64-bit, AWS Graviton)
│   └── package.json
├── darwin-x64/         # macOS Intel
│   └── package.json
└── darwin-arm64/       # macOS Apple Silicon (M1+)
    └── package.json
```

Each `package.json` declares `os`, `cpu`, and (for Linux) `libc` so
npm only installs the sub-package matching the current host. The
binary itself (`index.node`) is **not committed** — it's built and
copied in by the prebuilds workflow (see S9-3) at release time.

## How it's loaded

`src/infra/storage/napi-contract.ts:loadPlatformAwareBridge` tries
`require('@memphis-chains/memphis-${triple}')` first. If the sub-
package is installed (the operator is on a supported platform AND
hasn't disabled `optionalDependencies` via `--no-optional`), the
prebuilt binary loads. Otherwise the loader falls back to the
in-tree `crates/memphis-napi/index.node` produced by `npm run
build:rust:release`.

`detectPlatformTriple` in the same file determines the current
triple. Linux without glibc (Alpine/musl) returns `null` by design —
no musl prebuild yet, so musl operators always build from source.

## Why split this way

Single-package distribution would inflate the tarball with 4 binaries
on every install, even though npm only needs one. Per-platform sub-
packages let npm fetch ~10–20 MiB instead of 4× that. This pattern
is the napi-rs default and matches Rspack/Turbopack/Parcel.

The trade-off: 4 GH Packages publishes per release. The release
workflow (`.github/workflows/release.yml`) handles this in S9-3.

## Why not Windows / Alpine yet

- **Windows native**: `scripts/install.sh:152-155` rejects Windows
  (MINGW guard); operators run Memphis on WSL2 which inherits the
  Linux x64 prebuild. No native Windows prebuild planned for v1.8.x.
- **Alpine/musl**: low operator demand, build matrix already at 4
  triples. Operators on Alpine build from source via `npm run
  build:rust:release`. Adding a `linux-x64-musl` sub-package is a
  follow-up if demand emerges.

## Versioning

Each sub-package version mirrors the root `@memphis-chains/memphis`
version. Bumping the root version (`npm version <kind>`) bumps all
sub-packages in lockstep — handled by the release workflow.

The `0.0.0-placeholder` strings in committed `package.json` files
are CI-rewritten at publish time to the actual release version.

## See also

- `src/infra/storage/napi-contract.ts` — platform-aware loader
- `docs/dev/RUST-DISTRIBUTION.md` — full distribution architecture
- `.github/workflows/prebuilds.yml` — per-platform build matrix (S9-3)
- `scripts/postinstall-fetch-native.mjs` — fallback download (S9-4)
