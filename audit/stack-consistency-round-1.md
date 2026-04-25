# Stack Consistency Audit — Round 1 — 2026-04-25

**Scope**: Memphis runtime stack — Rust core → napi (`crates/memphis-napi`) → TypeScript runtime → MCP server → logging pipeline.
**Mode**: Read-only. No code changes.
**Methodology**: Plan file `/home/memphis/.claude/plans/full-scan-files-jiggly-wall.md`, 8 audit dimensions D1–D8.

## Summary

| Dim | P0 | P1 | P2 | Total | Headline |
|-----|----|----|----|-------|----------|
| D1 Napi parity | 0 | 2 | 0 | 2 | Phantom legacy aliases + missing alias entry |
| D2 Envelope conformance | 0 | 0 | 1 | 1 | Two envelope patterns coexist (lib.rs vs vault_bridge.rs) |
| D3 MCP registry | 0 | 1 | 2 | 3 | Default-allow policy; 6 dead handler files |
| D4 Rust→TS log gap | 0 | 0 | 1 | 1 | One `eprintln!` at boundary; operator-internal panics out-of-scope |
| D5 Container wiring | 0 | 0 | 2 | 2 | Transitive exports + 3 unused HTTP wires |
| D6 Config/env drift | 2 | 2 | 4 | 8 | Security-critical Rust env vars not in TS schema |
| D7 Boundary dead code | 0 | 0 | 1 | 1 | One test-only export leaking into prod surface |
| D8 Error uniformity | 0 | 0 | 1 | 1 | Boundary throws bare `Error`, ignores taxonomy |
| **TOTAL** | **2** | **5** | **12** | **19** | |

Two P0 findings (D6-1, D6-2) — both about security-critical Rust env vars that the operator cannot discover via the TS config schema. Five P1 findings concentrate on registry hygiene and config visibility. The bulk (12) are P2 hygiene items. **Total fits the predicted 20–40 envelope and below the 50 hard cap → suitable for a single bundled hotfix PR.**

## D1 — Napi Boundary Parity

### [P1] D1-1 Phantom legacy aliases (vault_encrypt, vault_decrypt)
- File: `/home/memphis/memphis/src/infra/storage/rust-vault-adapter.ts:97-101`
- Evidence:
  ```typescript
  const LEGACY_VAULT_BRIDGE_ALIASES = {
    vault_init_json: ['vault_init_json', 'vault_init', 'vaultInitJson'],
    vault_encrypt: ['vault_encrypt', 'vaultEncrypt'],
    vault_decrypt: ['vault_decrypt', 'vaultDecrypt'],
  ```
- Why it matters: `vault_encrypt` and `vault_decrypt` do not exist as Rust exports. The resolver flags them missing; any call paths through the legacy alias map throw `unavailable`.
- Fix direction: Drop both keys from `LEGACY_VAULT_BRIDGE_ALIASES` (the new contract is `vault_init_full`/`vault_store`/`vault_retrieve`); confirm no caller still names them.

### [P1] D1-2 `embed_shutdown` not in alias map
- File: `/home/memphis/memphis/src/infra/storage/rust-embed-adapter.ts:11-16`
- Evidence:
  ```typescript
  const EMBED_BRIDGE_ALIASES = {
    embed_store: ['embed_store', 'embedStore'],
    embed_search: ['embed_search', 'embedSearch'],
    embed_search_tuned: ['embed_search_tuned', 'embedSearchTuned'],
    embed_reset: ['embed_reset', 'embedReset'],
  };
  ```
- Why it matters: `embed_shutdown` is a real Rust export (`crates/memphis-napi/src/lib.rs:493`) called from `graceful-shutdown.ts` via dynamic `require`. The canonical adapter alias map does not declare it, so the embed adapter is not the single source of truth for embed bridge symbols.
- Fix direction: Add `embed_shutdown: ['embed_shutdown']` to the map; route the graceful shutdown caller through the adapter for consistency.

## D2 — Envelope Conformance

### [P2] D2-1 Two envelope patterns coexist on the napi boundary
- File: `/home/memphis/memphis/crates/memphis-napi/src/lib.rs:26-42` vs `/home/memphis/memphis/crates/memphis-napi/src/vault_bridge.rs:96-133`
- Evidence:
  ```rust
  // lib.rs — JSON-string envelope (14 exports)
  fn ok<T: Serialize>(data: T) -> String { /* {"ok":true,"data":...} */ }
  fn err(msg: impl Into<String>) -> String { /* {"ok":false,"error":...} */ }
  // vault_bridge.rs — native napi Result<T>
  #[napi(js_name = "vault_init_full")]
  pub fn vault_init_full(...) -> napi::Result<JsVaultInitOutput> { ... }
  ```
- Why it matters: The 14 lib.rs exports return JSON strings parsed via `parseEnvelope()` in TS. The 3 vault_bridge.rs exports return native napi types and bypass the envelope. Both work, but adapter code paths look different and a future contributor may apply the wrong one to a new export.
- Fix direction: Document the rule (when to use which) in a header comment in each file, or normalize to one pattern. Native napi Result is more idiomatic and gives structured errors; keep it for new exports and migrate gradually.

(Coverage: 17/17 envelope sites examined; all that use the JSON envelope correctly check `.ok` before reading `.data`.)

## D3 — MCP Tool Registry Hygiene

### [P1] D3-1 Tool permission table empty by default → silent default-allow
- File: `/home/memphis/memphis/src/infra/storage/sqlite/repositories/tool-permission-repository.ts:52-57`
- Evidence:
  ```typescript
  isAllowed(toolName: string) {
    const perm = this.get(toolName);
    if (!perm) return { allowed: true, policy: 'allow' };
  ```
- Why it matters: With no seed rows, all 35 registered MCP tools execute under `allow` policy. Sensitive tools (`memphis_restart`, `memphis_self_modify`, `memphis_deploy`, `memphis_exec`) have no enforced approval gate until the operator manually inserts policy rows — and the default-allow path is silent (no log).
- Fix direction: Seed restrictive defaults at bootstrap for the sensitive tool set (`require-approval` for restart/self-modify/deploy/exec; `deny` opt-in for fs-write). Surface the effective policy on `/status` so the operator can see it.

### [P2] D3-2 Six dead handler files in `src/mcp/tools/`
- Files:
  - `/home/memphis/memphis/src/mcp/tools/cron.ts`
  - `/home/memphis/memphis/src/mcp/tools/embed.ts`
  - `/home/memphis/memphis/src/mcp/tools/repair.ts`
  - `/home/memphis/memphis/src/mcp/tools/schedule.ts`
  - `/home/memphis/memphis/src/mcp/tools/send.ts`
  - `/home/memphis/memphis/src/mcp/tools/vault-get.ts`
- Evidence: Each exports a `runMemphis*` function but is never imported by `src/mcp/server.ts`.
- Why it matters: Dead surface area in MCP handler dir; future contributor may assume these are live tools.
- Fix direction: Delete the files, or register the tools and add policy rows. Pick one.

### [P2] D3-3 `fs-permission.ts` misclassified as a tool
- File: `/home/memphis/memphis/src/mcp/tools/fs-permission.ts`
- Evidence: Exports only helpers (`resolveFsPath`, `assertFsPermission`, `isTier3FsBypassActive`); no `runMemphis*` export, never registered.
- Why it matters: Lives under `tools/` but is shared infrastructure for `fs-ops`/`fs-write`.
- Fix direction: Move to `src/mcp/util/` or similar; update imports.

## D4 — Rust→TS Logging Gap

### [P2] D4-1 `eprintln!` on case-index error path bypasses pino
- File: `/home/memphis/memphis/crates/memphis-napi/src/lib.rs:628`
- Evidence:
  ```rust
  if let Err(e) = index_result {
      eprintln!("case_index warning: {e}");
  }
  ```
- Why it matters: Pino does not capture Rust stderr. Case-index failures during `case_append` are invisible to the operator's log file. The envelope already returns `indexed: bool` to JS, so we have a structured channel — we're simply not using it.
- Fix direction: Replace the `eprintln!` with an additional field on the envelope (`index_error: Option<String>`), or wrap via the existing `err()` helper if the failure should bubble.

### Out-of-scope finding (logged for follow-up)
- `crates/memphis-operator/src/chat.rs:1065+` contains 13 `serde_json::to_string(&json).unwrap()` calls in `execute_native_tool`. Initially flagged P0 by the audit agent on the assumption these are reachable from JS. **Verified**: `memphis-operator` is not a dependency of `memphis-napi`, no `#[napi]` exports exist in the crate, and grep of `crates/memphis-napi/src/` shows zero references to `memphis_operator`. These panics are Rust-internal and do not cross the napi boundary in the current build. They remain a hygiene concern for the operator runtime and should be tracked in a separate Rust-internal audit round, not this boundary audit.

## D5 — Bootstrap / Container Wiring

### [P2] D5-1 Container exports 9 transitive repositories with no semantic separation
- File: `/home/memphis/memphis/src/app/container.ts:43-55,119-137`
- Evidence: `sessionMemoryRepository`, `conversationCompactionRepository`, `seenProposalRepository`, `webhookEventRepository`, `agentPeerRepository`, `workerSessionRepository`, `workItemRepository`, `sessionTokenService`, `capacityWake` are all exported on the container return; some are injected into other services at construction (transitive), some are passed directly to HTTP server (direct), some are unused (optional).
- Why it matters: New contributors cannot tell at a glance which container fields are part of the public DI contract vs. internal wiring, increasing the chance of double-construction or accidental coupling.
- Fix direction: Split the container shape into `{ services, repositories, internal }` zones, or hide transitive-only repos as locals in `createAppContainer` and only return what bootstrap/HTTP actually consume.

### [P2] D5-2 Three optional repos registered but not passed to HTTP server
- File: `/home/memphis/memphis/src/app/bootstrap.ts:314-324`
- Evidence: `seenProposalRepository`, `webhookEventRepository`, `agentPeerRepository` are constructed in `createAppContainer` but omitted from the `createHttpServer(...)` options object. HTTP routes degrade gracefully via `?.` chains.
- Why it matters: Federation/webhook/peer features silently degraded on every boot — operator may not realize these routes are inert. Either intentional (delete) or accidental (wire up).
- Fix direction: Decide intent. Either pass all three to `createHttpServer` (and surface readiness on `/status`) or delete the registrations.

(Boot order verified clean — no use-before-register, no double-construction.)

## D6 — Config / Env Drift

### [P0] D6-1 `RUST_CHAIN_REQUIRE_SIGNATURES` not declared in TS schema
- File: `/home/memphis/memphis/crates/memphis-napi/src/lib.rs:79`
- Evidence:
  ```rust
  fn require_signed_blocks() -> bool {
      parse_bool_env("RUST_CHAIN_REQUIRE_SIGNATURES", false)
  }
  ```
- Why it matters: Toggles enforcement of cryptographic block signatures in the chain. Defaults to `false`. The operator has no schema-side surface for this, no validation, no `/status` visibility — the security posture of the chain layer is set by an env var that's not in the configuration model.
- Fix direction: Add the variable to the TS config schema with a documented default and surface its current value in `/status` (so the operator knows whether signature enforcement is on).

### [P0] D6-2 `RUST_CHAIN_SIGNER_KEY_HEX` not declared in TS schema
- File: `/home/memphis/memphis/crates/memphis-napi/src/lib.rs:83`
- Evidence:
  ```rust
  let raw = match std::env::var("RUST_CHAIN_SIGNER_KEY_HEX") {
      Ok(v) => v,
      Err(_) => return Ok(None),
  };
  ```
- Why it matters: Hex-encoded signing key for chain block signatures. Sensitive secret with no schema validation, no documentation, no redaction in logs (since it's not even known to the TS layer).
- Fix direction: Declare in schema as a redacted secret (zod `.optional()` + redaction list); document the format; ensure pino redaction covers it.

### [P1] D6-3 `MEMPHIS_OPERATOR_MAX_TOOL_TIER` not declared
- File: `/home/memphis/memphis/crates/memphis-operator/src/chat.rs:569`
- Evidence:
  ```rust
  fn max_tool_tier_from_env() -> u8 {
      std::env::var("MEMPHIS_OPERATOR_MAX_TOOL_TIER")
          .ok()
          .and_then(|v| v.trim().parse::<u8>().ok())
          .unwrap_or(2)
  }
  ```
- Why it matters: Caps the highest tool capability tier the operator runtime will execute. Default is 2 (Rust-only). Operators tuning safety expect to set this from the same place as TS-side config.
- Fix direction: Declare in TS schema with default `2`; document the tier model; surface effective value on `/status`.

### [P1] D6-4 `MEMPHIS_COGNITIVE_MODE` not declared
- File: `/home/memphis/memphis/crates/memphis-operator/src/runtime.rs:762`
- Evidence:
  ```rust
  std::env::var("MEMPHIS_COGNITIVE_MODE").unwrap_or_else(|_| "A".to_string())
  ```
- Why it matters: Selects cognitive variant A–E. Default `A` is Rust-only.
- Fix direction: Add to schema as enum with default `A`; document each variant.

### [P2] D6-5 `ANTHROPIC_OAUTH_AUTHORIZE_URL` consumed but not in schema
- File: `/home/memphis/memphis/src/infra/cli/handlers/auth.handler.ts:11`
- Fix direction: Add `ANTHROPIC_OAUTH_AUTHORIZE_URL: z.string().optional()` to schema.

### [P2] D6-6 `ANTHROPIC_OAUTH_REFRESH_TOKEN` consumed but not in schema
- File: `/home/memphis/memphis/src/providers/anthropic/adapter.ts:135`
- Fix direction: Add to schema as redacted secret.

### [P2] D6-7 `MEMORY_ROTATION_THRESHOLD` consumed but not in schema
- File: `/home/memphis/memphis/src/soul/memory.ts:161`
- Fix direction: Declare with default `50`.

### [P2] D6-8 ~11 TS-only undocumented env vars
- Examples: `GATEWAY_DANGEROUSLY_ALLOW_EXEC`, `MEMPHIS_CHAIN_REPAIR_ON_MISMATCH`, `MEMPHIS_DATA_DIR`, `MEMPHIS_LOG_FILE`, `MEMPHIS_LOCAL_WORKER_*`, `MEMPHIS_SYNC_*`, `PINATA_*`.
- Fix direction: Audit each individually — declare the operationally meaningful ones in the schema; keep the truly internal ones as `process.env` reads but add inline comments explaining scope.

## D7 — Boundary Dead Code

### [P2] D7-1 `resetActiveVault()` is test-only on the public surface
- File: `/home/memphis/memphis/src/infra/storage/rust-vault-adapter.ts:535`
- Evidence:
  ```typescript
  export function resetActiveVault(): void {
    activeVault = null;
  }
  ```
- Why it matters: Zero production callers; 5 test callers. Exporting a vault-reset on the public surface is a footgun.
- Fix direction: Move to `tests/test-helpers/vault.ts` (re-import the module-private state via a `__test__` namespace), or rename to `__resetActiveVaultForTests__` and document.

(Coverage: 17/17 napi exports verified live in production TS; 30 adapter methods checked.)

## D8 — Error Handling Uniformity

### [P2] D8-1 Boundary adapters throw bare `new Error()`, bypassing the existing taxonomy
- Files (representative):
  - `/home/memphis/memphis/src/infra/storage/rust-vault-adapter.ts` — 23 `throw new Error(...)`
  - `/home/memphis/memphis/src/infra/storage/rust-chain-adapter.ts` — 10 `throw new Error(...)`
  - `/home/memphis/memphis/src/infra/storage/rust-embed-adapter.ts` — 2 `throw new Error(out.error ?? 'rust bridge error')`
  - `/home/memphis/memphis/src/infra/storage/case-chain-adapter.ts` — 3
- Evidence:
  ```typescript
  // rust-embed-adapter.ts:60
  throw new Error(out.error ?? 'rust bridge error');
  ```
- Why it matters: An error taxonomy already exists (`AppError` in `src/core/errors.ts`, `RetryableError`, `MemphisExitError`). Adapters do not use it — every Rust-bridge failure becomes a generic `Error`, so callers must string-match `.message` to distinguish "bridge unavailable" from "rust returned ok=false" from "data missing". Incident triage harder than necessary.
- Fix direction: Introduce a small `RustBridgeError extends AppError` with discriminator (`reason: 'unavailable' | 'envelope_error' | 'empty_data' | 'serde_error'`) and migrate the 38 bare throws to it. Single-file change; no behavior change for callers that don't already inspect error type.

## Out of Scope (deliberately not audited)

- Performance / benchmarks; embedding model quality; SQLite schema evolution beyond MCP policy; log rotation thresholds (already PR #269); Fastify route business logic; MCP transport internals beyond registry surface; third-party crate audits; CSS/UI; business-logic test coverage.
- **Rust-internal panics in non-napi crates** (`memphis-operator/src/chat.rs` 13× `unwrap`) — flagged in §D4 "Out-of-scope finding" for a separate Rust-internal audit round.

## Coverage Manifest

| Item | Visited | Source |
|------|---------|--------|
| Napi exports | 17/17 | `grep -c '#\[napi(js_name' crates/memphis-napi/src/{lib,vault_bridge}.rs` |
| MCP tools registered | 35 | `server.registerTool(` in `src/mcp/server.ts` |
| MCP handler files | 36 | `ls src/mcp/tools/*.ts` |
| Adapters scanned | 5 | rust-chain, rust-embed, rust-vault, case-chain, graceful-shutdown |
| Rust crates scanned | 6/6 | memphis-core, memphis-napi, memphis-vault, memphis-embed, memphis-case-index, memphis-operator |
| Container tokens | 19/19 | `src/app/container.ts` |
| Env vars (Rust) | 16 | `env::var` in `crates/` |
| Env vars (TS) | 160+ | `process.env` in `src/` |
| Logging files | 6/6 | `pino, log-rotation, contextual, security-audit, audit-rotation, emergency-log` |

Status: **complete**. All counts reconcile.

## Recommended Next Step

Bundle all 19 findings into a single hotfix branch `hotfix/stack-consistency-round-1`, in this commit order:

1. **P0 first**: D6-1, D6-2 (declare RUST_CHAIN_* in schema + redaction)
2. **P1 batch**: D1-1, D1-2 (alias map cleanup), D3-1 (seed restrictive policies for sensitive tools), D6-3, D6-4 (operator/cognitive env vars)
3. **P2 hygiene**: D2-1 (envelope-pattern doc), D3-2, D3-3 (dead handlers + util reclassification), D4-1 (envelope index_error field), D5-1, D5-2 (container shape + HTTP wiring), D6-5..8 (TS schema completion), D7-1 (test-only export), D8-1 (RustBridgeError taxonomy)

Each commit references its finding ID (`fix(audit): D1-1 drop phantom legacy vault aliases`). Follow operator's Codex-style bundled-PR rule: one PR for the full round, not one per finding.
