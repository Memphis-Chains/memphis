# P1: Harden #603 fork-marker mitigation — Rust-side manifest + tests + doctor + config

## Why this matters

PR #603 shipped a TS-side substring-match catch around `verifyChainIntegrity()` to tolerate block 1853's known fork marker so the daemon could restart. It worked — `chain.verify.startup.known-fork` event audit-emitted, startup proceeded. But the implementation carries 7 distinct pieces of tech debt that violate the Memphis hotfix-skill grid (`feedback_codex_bundled_hotfix` + cross-layer-coverage). This follow-on closes them all.

## The 7 points

### 1. Tests gap (P0 within this PR — hotfix skill violation)

#603's grid claimed "positive path covered by chain-format-compat tests" but those exercise `verifyChainIntegrity()`'s success branch, never the new `catch → KNOWN_FORK_MARKERS.some()` branch. If a future Rust refactor renames the error string (`"integrity check failed at block N"` → `"integrity violation"`), the matcher silently falls through to the throw branch and every affected install crashes again with no warning.

**Fix:** add `tests/startup/chain-integrity-known-forks.test.ts` covering:
- Error message matches → emit `chain.verify.startup.known-fork`, startup continues
- Error message does NOT match (corruption at different block, or different error shape) → throws as today
- Both prev_hash literal pair pinning (see #4) match → mitigated; pair mismatch → throws

### 2. Fragile cross-layer coupling

Substring-match a Rust-formatted English error message from TS. Rust core in `memphis-core` and the TS catch site are in separate crates with no shared constant. A Rust string change silently breaks the mitigation.

**Fix:** Rust core exposes structured error `IntegrityError { chain: String, block: u64, prev_hash: String, expected_prev_hash: String }`. TS catches and inspects fields, not a substring.

### 3. The proper fix lives in Rust, not TS

#603's grid claimed `Rust core: –` but the bug **is** in Rust's strict verifier — TS just swallows the throw. Two installs hitting block 1853 still raise on every startup; we just hide it. Clean: Rust owns the accepted-forks decision.

**Fix:** add `crates/memphis-core/src/chain/accepted_forks.rs`:
- `AcceptedForks` struct loaded from `~/.memphis/known-forks.json` (per-install) or env `MEMPHIS_KNOWN_FORK_MARKERS` (override)
- `verify_with_known_forks(&self, manifest: &AcceptedForks) -> Result<(), IntegrityError>` API
- Manifest format: `[{ chain: "system", block: 1853, prev_hash_actual: "754a7c32...9d1b", prev_hash_expected: "4248ca68...cd62", reason: "PR #595 operator decision", added_at: "2026-05-12T..." }]`
- Verifier passes silently when error matches manifest entry; returns Err otherwise

TS host calls `verify_with_known_forks` instead of `verify_chain` + catch-and-match.

### 4. Matcher too loose

Today's `'chain \'system\' integrity check failed at block 1853'` accepts ANY future corruption at block 1853 — a second distinct fork pattern at the same block silently inherits operator's "Opcja A" decision. Should pin both block number AND specific prev_hash pair.

**Fix:** subsumed by #3 — manifest entry pins `(chain, block, prev_hash_actual, prev_hash_expected)` tuple. Any deviation throws.

### 5. doctor/status surfacing missed

A startup that ran a mitigation path is exactly what `memphis doctor` should surface. Operator currently has to grep `audit-log.jsonl` to know it happened.

**Fix:** new doctor check `tc01-chain-verify-mitigations`:
- Reads last startup's `chain.verify.startup.*` audit events
- `pass` if no mitigation ran
- `warn` with detail if mitigations ran ("chain 'system' block 1853 — operator-accepted fork from 2026-05-12")
- `fail` if mitigation manifest was loaded but verifier didn't see expected error (mismatch in accepted-forks file vs reality)

Also surface in `memphis status` JSON: `{chain_mitigations: [{chain, block, ...}]}`.

### 6. Decision hardcoded in TS source

A second install hitting the same block-1853 pattern would inherit `Memphis-Chains` operator's specific Opcja A decision baked into the binary.

**Fix:** subsumed by #3 — `~/.memphis/known-forks.json` is per-install config. Default ships **empty** (no inherited forks). Each operator opts into their own mitigation list.

### 7. Audit details unstructured

Today's audit event: `details.message: "<the entire error string>"`. Future audit consumers can't query "how many startups mitigated a fork at block N".

**Fix:** structured payload `{chain: "system", block: 1853, prev_hash_actual: "754a7c32...", prev_hash_expected: "4248ca68...", manifest_entry_id: "...", source: "known-forks-manifest"}`. The original error string moves to `details.raw_message` for debugging.

## Cross-layer grid

| Rust core | NAPI | TS host | CLI | TUI | Doctor | Tests |
|-----------|------|---------|-----|-----|--------|-------|
| ✅ accepted_forks module + verify_with_known_forks | ✅ expose `verifyChainWithKnownForks(manifest)` | ✅ replace substring catch with structured-error catch + manifest load | – (manifest is file-based config) | – | ✅ tc01 check | ✅ MUST — both branches + manifest load + Rust unit |

## Acceptance

- `verifyChainIntegrity()` substring catch in TS is **removed**; mitigation lives entirely in Rust verifier consuming structured manifest
- `~/.memphis/known-forks.json` ships empty by default; operator decision required to add entries
- Block 1853 mitigation is migrated to the manifest (one-time data migration script in this PR)
- `memphis doctor` surfaces mitigations on every run when active
- Audit events are structured tuples, not error-message blobs
- Both regression test cases (matching marker → continue, non-matching → throw) cover the path

## Memory hooks

- `feedback_codex_bundled_hotfix` — Codex round-N bundle convention; Codex review will likely catch sub-findings, fold them in
- `feedback_codex_review_judgment` — evaluate each finding vs Memphis convention; if a finding conflicts, reply on PR explaining (don't blindly comply)
- `feedback_truth_model_silent_catch` — replace `catch (e: any) {` blocks with typed-error + audit-with-cause
- `feedback_cross_layer_coverage` — all 7 grid columns hit
- `feedback_napi_rebuild_after_rust_changes` — operator runs compiled `.node`; after Rust core changes, ensure `npm run build:rust` in CI + handoff note for operator restart
