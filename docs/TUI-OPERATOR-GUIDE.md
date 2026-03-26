# Rust TUI Operator Guide

**Date:** 2026-03-26  
**Scope:** native Memphis operator console (`memphis tui`)

## Entry Point

```bash
memphis tui
```

`memphis tui` now launches the Rust console. The old TypeScript TUI is no longer an active product surface.

The Rust console stays thin over the same provider, tool, auth, vault, and runtime contracts as CLI, HTTP, MCP, and the gateway.

Important architecture note:

- `memphis-tui` now reads operator state through the native Rust seam `memphis-tui -> memphis-operator -> Rust crates`,
- `memphis-napi` remains the Rust ↔ TypeScript bridge for the TypeScript runtime, not the primary seam for the Rust console,
- chat parity is still the remaining major Rust TUI gap, and is intentionally not faked through the TypeScript HTTP runtime.

## Current Native Scope

The Rust console now ships the full 7-screen operator model:

| Key | Screen | Purpose |
|-----|--------|---------|
| `1` | Overview | Native runtime summary, provider default, memory counters, chain and vault counts |
| `2` | Chat | Reserved for native operator chat parity; not proxied through TS HTTP |
| `3` | Memory | Semantic recall, exact search status, and native memory index summary |
| `4` | Sessions | Native session listing from the runtime SQLite store |
| `5` | Vault | Native vault metadata view and explicit direct-read command surface |
| `6` | Cases | Native case / decision rows from the case index |
| `7` | System | Native runtime paths, bridge state, optional channel readiness, and health summary |

Current control keys:

| Key | Action |
|-----|--------|
| `1..7` | Switch screen |
| `r` | Refresh from the local runtime |
| `/` | Enter command mode |
| `q` | Quit |

Current built-in commands:

- `/memory semantic <query>`
- `/memory exact <query>`
- `/vault get <key>`

## Runtime Model

Current architecture:
- `memphis-tui -> memphis-operator -> Rust crates`
- `memphis-napi` remains the Rust ↔ TypeScript bridge for the TypeScript runtime
- no TypeScript TUI fallback
- no HTTP-first Rust console architecture

Current native data sources already wired through `memphis-operator`:
- local runtime root and chain directories
- SQLite session and exact-search tables
- embedding persistence for semantic recall
- vault state + entries files
- case index rows

Remaining parity work:
- native operator chat runtime
- deeper provider/runtime parity inside the Rust operator layer
- final RC polish once chat lands

## Vault Rule

The `Vault` screen is metadata-first.

Direct secret reads remain bounded to explicit operator command paths and must not leak into:
- prompt fragments
- memory
- audit payloads
- background model output

## References

- `crates/memphis-tui/src/main.rs`
- `crates/memphis-tui/src/app.rs`
- `crates/memphis-tui/src/client.rs`
- `crates/memphis-operator/src/lib.rs`
- `crates/memphis-operator/src/runtime.rs`
