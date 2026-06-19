# Memphis one-truth Phase 3 - bridge readiness gate - 2026-06-04

Scope: make Rust NAPI bridge manifest an operational gate across CLI readiness,
doctor, and optional daemon startup.

Status updated: 2026-06-06 after implementation and live-service smoke.

## Implemented

- Added Rust NAPI `bridge_manifest` export in `crates/memphis-napi`.
- Added shared bridge assessment:
  - `assessRustBridgeManifestStatus`
  - `strictRustBridgeRequired`
- Readiness now checks the bridge manifest contract instead of only checking
  whether the chain adapter loaded.
- HTTP health now reports the same bridge assessment as readiness and doctor.
- Doctor now prints a Tier 1 `Rust bridge manifest` check with:
  - bridge path
  - rust enabled flag
  - loaded/manifest availability
  - missing required exports
  - full manifest metadata
- `MEMPHIS_STRICT_RUST_BRIDGE=1` is implemented in the shared assessor and
  makes readiness/health/doctor fail when Rust is disabled or incomplete.
- Daemon bootstrap now uses the same assessor: in strict mode it refuses
  startup on stale/missing/incomplete NAPI bridge builds with rebuild
  instructions; in non-strict mode it records a bootstrap warning and
  continues.
- Doctor now distinguishes public chat hardening failures from an allowlisted
  operator Telegram surface. Public risky chat surfaces still fail; allowlisted
  Telegram risk is a non-required warning with explicit wording.
- `scripts/run-rust.sh` now atomically replaces `crates/memphis-napi/index.node`
  so live Node processes are not exposed to a truncated addon during rebuild.

## Gate Policy

- `RUST_CHAIN_ENABLED=false`
  - readiness/doctor: warn unless strict mode is enabled
  - strict mode: fail
- Rust enabled but bridge not loadable
  - fail
- Rust enabled and bridge loadable but no `bridge_manifest`
  - fail
- Manifest available but required exports missing
  - fail
- Manifest available with required exports
  - pass

Required exports currently checked:

- `bridge_manifest`
- `chain_append`
- `chain_validate`
- `chain_query`
- `vault_init_json`
- `vault_init_full`
- `vault_store`
- `vault_retrieve`
- `embed_store`
- `embed_store_many`
- `embed_flush`
- `embed_search`
- `embed_search_tuned`
- `embed_reset`
- `embed_shutdown`
- `soul_loop_step`
- `soul_replay`
- `case_append`
- `case_query`
- `case_rebuild`
- `paths_resolve_data_dir`
- `paths_resolve_vault_state`
- `paths_resolve_vault_entries`
- `paths_resolve_chains_dir`
- `paths_resolve_chain_path`
- `paths_resolve_embed_index`
- `paths_resolve_case_index`
- `paths_resolve_database_path`
- `paths_normalize_chain_name`

Optional exports currently advertised by the manifest:

- `mv2_export`
- `mv2_inspect`

## Verification

Passed:

- `cargo test -p memphis-napi bridge_manifest`
- `npx vitest run tests/unit/rust-bridge-manifest.test.ts tests/unit/readiness.test.ts tests/unit/http.health.test.ts`
- `npm run typecheck`
- `npm run build`
- `memphis readiness --json`
- `memphis health --json`
- `memphis doctor --json`
- `systemctl --user restart memphis.service memphis-public-chat.service`
- `systemctl --user is-active memphis.service memphis-public-chat.service`
- `curl -sS http://127.0.0.1:8787/health`

Observed:

- `readiness` reports `rust_bridge` as OK:
  `Rust bridge manifest OK (29 required exports)`.
- `health` reports `runtimeStatus: healthy`,
  `checks.rust_bridge.status: ok`, and the same 29-export bridge message.
- `doctor` reports the new Tier 1 `Rust bridge manifest` check as pass.
- `doctor` exits OK with `requiredFailures=0`. Telegram is still surfaced as
  `[operator allowlisted]` warning because it has tier2/unknown-tools/operator
  override/URL fetch enabled, but it is not treated like a public chat surface
  when `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS` is configured.
- systemd logs show clean graceful shutdown for both services:
  `shutdown complete; exiting 0` for `memphis.service` and graceful shutdown
  complete for `memphis-public-chat.service`.
- `process-lock` now has a systemd MainPID fallback when `process.kill(pid, 0)`
  reports `ESRCH`; this prevents a second runtime from treating a live
  systemd-managed Memphis process as stale in normal user-service environments.

## Remaining Follow-Ups

- Decide whether to keep Telegram as elevated operator surface permanently or
  add an explicit `surfaceClass` override in the surface-policy model.
- Normalize the cosmetic `./data/memphis.db` paths still printed by some Rust
  TUI snapshot fields.
- Consider enabling `MEMPHIS_STRICT_RUST_BRIDGE=1` after the deployment flow
  consistently rebuilds `crates/memphis-napi/index.node` before restart.
- In the Codex sandbox, Node child processes cannot access the systemd user bus
  or netlink (`EPERM`), so `memphis doctor` can still show non-required
  `t5-stale-locks` / `t5-process-lock` warnings even while external
  `systemctl --user status` and `ss -ltnp` show the service and ports alive.
