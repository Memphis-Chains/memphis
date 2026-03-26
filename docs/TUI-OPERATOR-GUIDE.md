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

- the current foundation shell still uses the local HTTP control plane for a narrow bootstrap slice,
- this is transitional only,
- the accepted `v1.0.0` target is a native Rust operator seam via `memphis-operator`, not an HTTP-first TUI.

## Current Foundation Scope

Sprint 1 lands the Rust foundation shell with these screens:

| Key | Screen | Purpose |
|-----|--------|---------|
| `1` | Overview | Runtime health, uptime, provider count, adapter summary |
| `2` | Chat | Native chat console target and provider summary |
| `3` | Memory | Canonical recall contract and embedding bridge status |
| `4` | Vault | Metadata-only vault view |
| `5` | System | Provider health and runtime timestamp summary |

Current control keys:

| Key | Action |
|-----|--------|
| `1..5` | Switch screen |
| `r` | Refresh data from the local HTTP control plane |
| `q` | Quit |

## Runtime Model

The current foundation shell on `main` reads a narrow bootstrap slice from the local HTTP control plane. This is not the accepted release architecture.

`v1.0.0` target architecture:
- `memphis-tui -> memphis-operator -> Rust crates`
- `memphis-napi` remains the Rust ↔ TypeScript bridge for the TypeScript runtime
- no TypeScript TUI fallback
- no “native-looking” Rust console built as a permanent HTTP costume

Current data sources:
- `/api/status`
- `/v1/vault/entries`

Planned parity additions for the next Rust TUI sprints:
- native `Overview`, `Memory`, `Vault`, and `System` services through `memphis-operator`
- native operator chat parity as a release requirement
- `Sessions`
- `Cases / Decisions`

## Vault Rule

The `Vault` screen is metadata-only.

Direct secret reads remain bounded to explicit operator command paths and must not leak into:
- prompt fragments
- memory
- audit payloads
- background model output

## References

- `crates/memphis-tui/src/main.rs`
- `crates/memphis-tui/src/app.rs`
- `crates/memphis-tui/src/client.rs`
