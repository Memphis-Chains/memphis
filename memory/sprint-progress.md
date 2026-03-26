# Memphis Sprint Progress Memory

**Last Updated:** 2026-03-26  
**Canonical roadmap:** `docs/EXECUTION-PLAN.md`

This file is a local execution snapshot, not a second roadmap. Historical sprint labels are preserved only when they help explain how the current `main` was built.

## Current Status

Memphis is in late pre-`v1.0.0` closure work, but `v1.0.0` has now been rebased around a Rust-native primary TUI.

Large architecture and hardening tracks already landed on `main`:

- runtime contract unification across gateway, CLI, TUI, HTTP, and MCP
- vault boundary hardening with explicit operation classes
- rollback and recovery alignment with the real runtime state model
- prompt boundary, input classification, content scanning, and output guard
- self-modify reliability with snapshot/test-gate recovery
- TypeScript TUI `6A`, `6B`, and `6C` as migration groundwork
- Matrix trusted-pilot setup truth and vault-safe setup flow
- install / package / CI support-matrix alignment on Node `22 LTS`
- durable write normalization onto the supported Rust block contract

## Latest Landed Sprint

### Provider + Prompt-Security Closure Sprint - COMPLETE

Commit: local sprint closure commit for provider/runtime truth, final prompt-boundary hardening, and live docs cleanup

Delivered:

- active provider truth is now aligned across config, HTTP contracts, MCP, CLI parsing/help/completion, and Rust operator runtime
- the active `v1.0.0` provider set is now explicit everywhere:
  - `local-fallback`
  - `ollama`
  - `shared-llm`
  - `decentralized-llm`
  - `minimax`
  - `deepseek`
  - `glm`
- `providers list` and `models list` no longer collapse remote providers into an `openai-compatible` bucket
- `DEFAULT_PROVIDER` now truthfully accepts the full current set, including `minimax` and `deepseek`
- prompt/output guard now redacts leaked developer-prompt references in both TS and Rust operator chat paths
- prompt-security wording now explicitly calls out provenance classes:
  - `user_input`
  - `fetched_content`
  - `recalled_memory`
  - `tool_output`
- Rust TUI `Overview` and `System` now surface provider status truth directly from `memphis-operator`
- active verification docs no longer present OpenClaw plugin checks as part of the live `v1.0.0` validation story

Validation for this sprint:

- `cargo test -p memphis-operator`
- `cargo test -p memphis-tui`
- `npm run typecheck`
- `npm run test:ts`
- `npm run test:rust`

### Rust Operator + Native Chat Sprint - COMPLETE

Commit: local sprint closure commit for `memphis-operator`, native Rust TUI parity, and native chat

Delivered:

- added `crates/memphis-operator` as the native Rust operator-facing service layer
- Rust TUI no longer reads its primary non-chat data over the local HTTP control plane
- native snapshot and operator reads now cover:
  - `Overview`
  - `Chat`
  - `Memory`
  - `Sessions`
  - `Vault`
  - `Cases / Decisions`
  - `System`
- native chat now provides:
  - multi-turn transcript persistence in the local runtime SQLite store
  - provider/model selection state in the Rust console
  - native operator tool/runtime subset over `memphis-operator`
  - prompt-boundary and output-guard enforcement on the Rust path
- `memphis tui` remains the Rust console entrypoint and the old TypeScript TUI stays out of active product truth
- live docs now state the real seam:
  - `memphis-tui -> memphis-operator -> Rust crates`
- the main remaining `v1.0.0` closure work after this sprint is:
  - provider/runtime polish for the full current provider set
  - final prompt-injection / untrusted-content hardening pass across the Rust and TS chat surfaces
  - Matrix/OpenClaw/docs RC truth pass
  - RC shakeout and release proof

Validation for this sprint:

- `cargo test -p memphis-operator`
- `cargo test -p memphis-tui`
- `npm run typecheck`
- `npm run test:rust`
- `npm run test:ts`

### Chain Export + RC Cleanup Sprint - COMPLETE

Commit: local sprint closure commit for chain export, fallback truth pass, and executed GitHub branch cleanup

Delivered:

- `memphis chain export --chain <name> [--out <file>]` is now implemented
- export is single-chain only for `v1.0.0`; `--all` stays explicitly out of scope
- export envelope is import-compatible with `chain import_json`
- `src/resilience/*` is now explicitly treated as experimental/internal, not as the GA recall contract
- doctor and operations docs now report hybrid recall as canonical and the resilience module as non-GA scaffolding
- remote branch cleanup from `memory/github-branch-cleanup-2026-03-26.md` has been executed:
  - `core/bridge-correctness`
  - `feat/consolidate-memphisos`
  - `feat/memory-routes`
  - `feat/rust-chain-activation`
  - `feat/soul-system-phase-a`
  - `fix/vault-masterkey`
  - `release/0.3.1`
- `origin/main` is now the only active remote branch

Validation for this sprint:

- `npx vitest run tests/unit/chain-export.test.ts tests/unit/cli.chain-export.test.ts tests/unit/resilience.test.ts tests/unit/resilience/fallback.test.ts tests/ops/install-support-matrix-docs-contract.test.ts tests/unit/operator-guide.test.ts`
- `npm run typecheck`

### Exact Recall + Branch Cleanup Sprint - COMPLETE

Commit: `8b405ee` `feat(memory): add exact recall and branch cleanup inventory`

Delivered:

- hybrid recall is now explicit:
  - `memphis_recall` = semantic recall via embeddings / HNSW
  - `memphis_search` = exact phrase lookup via derived SQLite `FTS5`
- exact recall is wired through:
  - MCP
  - gateway in-process tool executor
  - HTTP `POST /api/search`
  - CLI `memphis search --query ...`
- durable write paths now feed the exact-search index:
  - journal-backed memory
  - decision writes
  - cognitive durable blocks
- exact search index is derived and rebuildable from chain data
- branch cleanup inventory recorded in `memory/github-branch-cleanup-2026-03-26.md`
- `origin/feat/memory-routes` explicitly marked salvage-only and non-mergeable
- live docs updated for hybrid recall, current TUI model, and canonical architecture truth

Validation for this sprint:

- `npm run typecheck`
- `npm run test:ts` -> `278/278` files, `1189/1189` tests
- `npm run release:smoke` -> PASS

## Historical Notes

### Early Scan / P0 Sprint Stack - HISTORICAL

Older scanning and P0-fix sprints were useful inputs, but they are no longer active planning units. Their outputs have either been absorbed into the current runtime or superseded by the canonical roadmap.

Examples of historical-only topics:

- early TUI layout experiments
- review-agent sweeps
- pre-hardening provider and storage drift notes

## Active Focus After This

- fresh-host RC shakeout and release-candidate proof
- final Matrix trusted-pilot and docs/runbook sweep

What remains is now a targeted release rebase:

1. fresh-host / clean-environment RC drill
2. last release/runbook truth pass for Matrix optional pilot
3. final bug burn-down from the RC drill

## Related Files

- `docs/EXECUTION-PLAN.md` — canonical roadmap
- `docs/CANONICAL-ARCHITECTURE.md` — current architecture and remaining gaps
- `memory/github-branch-cleanup-2026-03-26.md` — remote branch inventory and cleanup decisions
