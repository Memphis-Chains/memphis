# Rust TUI Operator Guide

**Date:** 2026-03-26  
**Scope:** native Memphis operator console (`memphis tui`)

## Entry Point

```bash
memphis tui
```

`memphis tui` now launches the Rust console. The old TypeScript TUI is no longer an active product surface.

The Rust console stays thin over the same provider, tool, auth, vault, and runtime contracts as CLI, HTTP, MCP, and the gateway.

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

The Rust TUI uses the existing local HTTP control plane first. It does not invent a second runtime stack.

Current data sources:
- `/api/status`
- `/v1/vault/entries`

Planned parity additions for the next Rust TUI sprints:
- interactive chat over `/v1/chat/completions`
- memory search/recall views
- sessions
- cases / decisions

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
