# What Is Left To Do

Updated: 2026-03-12

## Carry-Over / Blocked

- [x] Apply GitHub branch protection on `main` with a repo-admin token via `npm run -s ops:protect-main`.
  - Confirmed enabled on 2026-03-12 with expected settings (`quality-gate`, admin enforcement, linear history, conversation resolution).

## Completed In This Pass

- [x] Finish `src/cli/commands/insight.ts` TODOs:
  - real block loading by period (`journal`, `decision`, `reflections`)
  - save-to-chain implementation for insight reports
  - added unit tests: `tests/unit/cli.insight-command.test.ts`
- [x] Implement remote agent broadcast in `src/cognitive/model-d.ts`.
  - HTTP(S) broadcast path + remote vote ingestion + broadcast result tracking
  - added coverage in `tests/cognitive/model-d-comprehensive.test.ts`
- [x] Implement Telegram delivery path in `src/cognitive/proactive-assistant.ts` when configured.
  - configurable fetch + timeout + safe fallback logging
  - added tests: `tests/unit/proactive-assistant-telegram.test.ts`
- [x] Migrate DID encoding from hex to base58btc.
  - Rust vault DID now emits multibase base58btc with Ed25519 multicodec prefix (`did:memphis:z...`)
  - added DID encoding test coverage in `crates/memphis-vault/src/did.rs`
- [x] Complete user-facing docs gap from release report.
  - added `docs/COGNITIVE-MODELS.md`
  - added `docs/CLI-REFERENCE.md`
  - release report TODO checklist updated to done
- [x] Replace TODO-guarded Vault Phase 1 test gap with full implementation evidence.
  - docs updated in `docs/VAULT-PHASE1-PLAN.md`
  - verified via `cargo test -p memphis-vault` and TS vault e2e/unit suites
- [x] Expand retrieval benchmark corpus and re-baseline thresholds.
  - new corpus: `data/retrieval-benchmark-corpus-v3.json` (18 docs / 24 cases)
  - defaults moved from v2 to v3 in benchmark scripts
  - thresholds tightened in `scripts/retrieval-benchmark-gate.ts`
- [x] Add focused CLI startup + TUI refresh latency benchmarks.
  - new script: `scripts/cli-tui-latency-benchmark.ts`
  - new npm command: `npm run -s bench:cli-tui`
  - new doc: `docs/CLI-TUI-LATENCY-BENCHMARK.md`

## Completed In This Pass (v1.8 Sprint Build Start)

- [x] Implement emergency logging path resolver with fallback order and secure file permissions (`0600`).
  - Added runtime module: `src/infra/runtime/emergency-log.ts`
  - Added tests: `tests/unit/emergency-log.test.ts`
- [x] Implement strict exit code plumbing for hardening/corruption paths.
  - Added `src/infra/runtime/exit-codes.ts`
  - Wired `src/index.ts` and CLI runner to honor runtime exit codes.
- [x] Implement safe-mode kernel boundary enforcement.
  - `agent/system.ts`: command/app launch blocked in safe mode.
  - `modules/orchestration/service.ts`: generation blocked in safe mode.
  - `gateway/server.ts`: `/exec` + `/provider/chat` blocked in safe mode.
  - `infra/http/server.ts`: read-only route allowlist in safe mode.
  - Added tests: `tests/unit/safe-mode-boundary.test.ts`, `tests/unit/safe-mode-runtime.test.ts`, gateway e2e coverage.
- [x] Implement WAL integrity layer with lock + checksum + tail truncation recovery.
  - Added `src/infra/storage/task-queue-wal.ts`
  - Features: lockfile exclusivity, CRC32C per record, deterministic fault injection hook, torn-write recovery.
  - Added tests: `tests/unit/task-queue-wal.test.ts`
- [x] Implement identity normalization + DB-level approval constraints foundation.
  - Added `src/infra/auth/identity.ts`
  - Added approvals schema constraints in `src/infra/storage/sqlite/client.ts`
  - Added repository `src/infra/storage/sqlite/repositories/approval-repository.ts`
  - Added tests: `tests/unit/approval-repository.test.ts`
- [x] Implement alert dedupe + fallback emitter primitive.
  - Added `src/infra/logging/alert-emitter.ts`
  - Includes suppressed-count summary event and emergency-log fallback path.

## Next Task List (Based On Findings)

- [x] Wire a real receiver endpoint for Model D remote proposal broadcast (`/api/model-d/proposals`) on peer nodes.
  - Added request validation, deterministic vote output, audit logging, and HTTP e2e tests.
- [x] Decide release targets for latency SLOs using initial baseline in `data/cli-tui-latency-benchmark-reports/latest.json`.
  - Set SLOs and added `bench:cli-tui:gate` with CI wiring.
- [x] Roll out signed-block strict mode (`RUST_CHAIN_REQUIRE_SIGNATURES=true`) in staged environments and publish key-rotation policy for signers.
  - Added signer-key support (`RUST_CHAIN_SIGNER_KEY_HEX`) in Rust NAPI append flow.
  - Added rollout + key-rotation runbook in `docs/RUST-CHAIN-SIGNING-ROLLOUT.md`.
- [x] Add branch-protection follow-up check in release checklist to ensure `quality-gate` and required settings stay enforced.
  - Added `npm run -s ops:verify-main-protection` and release checklist note.

## Next Task List (After This Pass)

- [ ] Add signer allowlist verification in Rust core so `verify_block_signature` can be policy-constrained (not just cryptographically valid).
- [ ] Add replay protection for `/api/model-d/proposals` (proposal dedupe window and idempotency key).
- [ ] Add CI check that validates signed-block append path end-to-end with `RUST_CHAIN_REQUIRE_SIGNATURES=true`.
- [ ] Add metrics for Model D endpoint (`approve/reject/abstain` counts and response latency) to `/metrics`.
- [ ] Wire `TaskQueueWal` into an actual API/task ingestion path with backpressure (`max_pending_tasks`) and queue-mode (`financial|standard`) ACK semantics.
- [ ] Build dual-approval state machine persistence (`PendingFreeze`/`PendingUnfreeze`) with CAS/transaction boundaries and event emission.
- [ ] Add safe-mode runbook docs + systemd exit code mapping (`RestartPreventExitStatus=102,103`).
- [ ] Add trust-root validation module + downgrade rejection tests (`new_version > current_version`).
