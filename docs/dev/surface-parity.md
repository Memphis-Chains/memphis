# Surface parity

Memphis exposes several operator-facing surfaces that historically each
grew their own capability list. Sprint 7 closes the gap so capabilities
that one surface offers are available on every surface that should
logically carry them — and makes that expectation testable.

## Surface layers

| Surface         | Transport                                  | Primary user                                      |
| --------------- | ------------------------------------------ | ------------------------------------------------- |
| **Telegram**    | grammY bot on Telegram Bot API             | remote operator on phone                          |
| **TUI host**    | JSON-RPC over stdio to the Rust TUI client | local operator in the terminal                    |
| **MCP stdio**   | Model Context Protocol stdio server        | external MCP-speaking clients (Claude Code, etc.) |
| **HTTP**        | Fastify REST at `/v1/*` and `/api/*`       | programmatic callers, dashboards, workers         |
| **Rust / NAPI** | `crates/memphis-napi` native bindings      | internal bridge for TypeScript → Rust primitives  |

Rust/NAPI is an **internal bridge**, not an operator surface. It
intentionally exposes low-level primitives (chain, vault, embed, soul)
rather than operator commands. The four operator surfaces that should
carry parity are Telegram, TUI, MCP stdio, and HTTP.

## Capability matrix

Legend: ✓ present · — intentionally absent · (see) follow-up sprint

| Capability                                  | Telegram              | TUI host                           | MCP stdio                 | HTTP                              | Notes                                          |
| ------------------------------------------- | --------------------- | ---------------------------------- | ------------------------- | --------------------------------- | ---------------------------------------------- |
| `/status`                                   | ✓ `/status`           | ✓ `health.status`                  | ✓ `memphis_health`        | ✓ `/v1/ops/status`                | Sprint 5                                       |
| cross-surface presence                      | ✓ in `/status`        | ✓ `presence.snapshot`              | ✓ `memphis_presence`      | ✓ `/v1/ops/status.activeSurfaces` | Sprint 5 + Sprint 7 (MCP)                      |
| cognitive mode get / set                    | ✓ `/mode`             | ✓ `cognitive.mode`                 | — (not yet wired)         | —                                 | Sprint 4; MCP wiring is a follow-up            |
| tier elevation (1/2)                        | ✓ `/tier 2`           | ✓ `security.tier.elevate`          | —                         | —                                 | Telegram-native flow                           |
| tier-3 elevation                            | ✓ `/tier 3 <pass>`    | ✓ `security.tier.elevate --tier 3` | —                         | —                                 | intentionally operator-only                    |
| config show                                 | ✓ `/config show`      | ✓ `config.show`                    | ✓ `memphis_config_show`   | ✓ `/v1/ops/config/show`           | Sprint 6 + Sprint 7 (MCP)                      |
| config set                                  | ✓ `/config set KEY=V` | ✓ `config.set`                     | — (read-only)             | ✓ `/v1/ops/config/set`            | MCP intentionally read-only (no tier-3 prompt) |
| config reload                               | ✓ `/config reload`    | ✓ `config.reload`                  | ✓ `memphis_config_reload` | ✓ `/v1/ops/config/reload`         | Sprint 6 + Sprint 7 (MCP)                      |
| surface policy set                          | —                     | ✓ `config.surfaces.set`            | —                         | —                                 | operator-local policy editing                  |
| chain verify                                | —                     | ✓ via CLI                          | —                         | —                                 | Sprint 12 CLI                                  |
| pulse / heartbeat status                    | —                     | ✓ `pulse.status`                   | —                         | —                                 | local runtime health                           |
| fs read/write (code-read, fs-ops, fs-write) | ✓ (tier 2+)           | ✓ (tier 2+)                        | ✓                         | —                                 | policy-gated via `assertFsPermission`          |
| exec (shell)                                | ✓ (tier 2+)           | ✓ (tier 2+)                        | ✓                         | —                                 | policy-gated via `assertExecCommand`           |
| web_fetch / web_search                      | ✓                     | ✓                                  | ✓                         | —                                 | network-gated                                  |
| vault (encrypt / decrypt / list)            | —                     | —                                  | ✓                         | ✓                                 | operator-facing vault uses the CLI, not chat   |

## Enforcement parity

Every surface that can execute a side-effect routes through the same
enforcement points:

- `resolveSurfacePolicy()` (`src/gateway/surface-policy.ts`) — per-surface
  tier ceiling for tool dispatch.
- `applyTier3EnvOverride()` (`src/gateway/turn-runtime.ts`, Sprint 2) —
  overlays tier-3 environment variables when an active session exists.
- `assertFsPermission()` (`src/mcp/tools/fs-permission.ts`) — tier-gated
  filesystem sandbox for `memphis_fs_*` tools.
- `assertExecCommand()` (`src/gateway/exec-policy.ts`) — tier-gated
  command allowlist for `memphis_exec`.

The MCP tool additions in Sprint 7 (`memphis_presence`,
`memphis_config_show`, `memphis_config_reload`) do not bypass these
checks because they don't touch the filesystem or exec paths —
`config.*` only mutates `process.env` + `.env` via the vetted
`setDotEnvValues()` helper, and `presence` is pure read.

## Contract tests

`tests/integration/surface-parity.test.ts` — for each Sprint-7 MCP tool,
assert the shape and values returned by MCP match the corresponding
TUI host capability when both read from the same in-process registry
/ env state.

The test is a lightweight surface contract: when a Sprint adds a new
capability to one surface, adding it to the parity test here catches
drift if a future sprint ships to only one surface.

## What Sprint 7 is not

- It is not a rewrite of the NAPI surface. NAPI is the internal TS⇄Rust
  bridge; it stays a set of low-level primitives.
- It is not a unified RPC. Each surface keeps its native protocol
  (Telegram commands, TUI host JSON-RPC, MCP stdio, HTTP REST) — the
  parity is at the _capability_ level, not the wire format.
- It does not add surface-level rate limits or quotas. Rate limits
  remain where they already are (HTTP global + sensitive limiters
  from Sprint 2's hardening, per-chat Telegram tier TTL).
