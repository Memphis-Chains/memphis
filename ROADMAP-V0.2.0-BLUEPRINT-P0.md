# ROADMAP-V0.2.0-BLUEPRINT-P0.md

Real-deal.

## Mission
Execute BLUEPRINT Phase 0 safely: establish Rust foundation + minimal NAPI bridge + non-breaking TS integration path.

## Principles
- Pro quality over speed
- No big-bang refactor
- Every slice has rollback
- Keep main stable

## Timeline (suggested: 5 working days)

## Day 1 — S1 foundation bootstrap

### T1: Create Rust workspace skeleton
- Owner: Memphis
- Priority: P0
- KPI: workspace compiles (`cargo check --workspace`)
- Risk: tooling mismatch on host
- Rollback: revert Rust bootstrap commit
- DoD:
  - root `Cargo.toml` with `[workspace] members = ["crates/*"]`
  - crates created: `memphis-core`, `memphis-napi`

### T2: Core module skeleton (`memphis-core`)
- Owner: Memphis
- Priority: P0
- KPI: unit tests scaffold exists and runs
- Risk: overdesign too early
- Rollback: keep stubs only, no TS coupling yet
- DoD:
  - files: `block.rs`, `hash.rs`, `soul.rs`, `chain.rs`, `error.rs`, `lib.rs`
  - minimal compile green

## Day 2 — S1 validation core

### T3: Deterministic block/hash tests
- Owner: Memphis
- Priority: P0
- KPI: stable hash test pass x2 runs
- Risk: serialization drift
- Rollback: freeze schema + explicit serde attrs
- DoD:
  - test: identical input => identical hash

### T4: Chain rules tests
- Owner: Memphis
- Priority: P0
- KPI: genesis/link integrity tests pass
- Risk: incorrect edge-case handling
- Rollback: narrow validator scope to strict essentials
- DoD:
  - test: genesis prev_hash zero
  - test: sequential index
  - test: prev_hash match

## Day 3 — S2 minimal NAPI bridge

### T5: `memphis-napi` exports v1
- Owner: Memphis
- Priority: P0
- KPI: build produces usable bridge artifact
- Risk: napi toolchain friction
- Rollback: keep API thin and isolate build scripts
- DoD:
  - exported functions: `chain_append`, `chain_validate`, `chain_query`
  - minimal smoke invocation passes

### T6: Bridge contract doc
- Owner: Memphis
- Priority: P0
- KPI: one doc describing inputs/outputs/errors
- Risk: contract ambiguity
- Rollback: lock v1 JSON schema and defer extras
- DoD:
  - `docs/NAPI-CONTRACT-V1.md` exists

## Day 4 — S3 non-breaking TS integration

### T7: TS chain adapter with feature flag
- Owner: Memphis
- Priority: P0
- KPI: both modes executable
- Risk: accidental default switch
- Rollback: default flag remains off
- DoD:
  - `RUST_CHAIN_ENABLED=false` default
  - TS path unchanged when off

### T8: Dual-path smoke tests
- Owner: Memphis
- Priority: P0
- KPI: smoke passes for both flag modes
- Risk: flaky runtime coupling
- Rollback: split tests and isolate environment inputs
- DoD:
  - smoke A (TS legacy): PASS
  - smoke B (Rust path): PASS

## Day 5 — Gate and release prep

### T9: Gate review A/B/C
- Owner: Memphis
- Priority: P0
- KPI: all gates green
- Risk: hidden instability
- Rollback: hold release and fix forward
- DoD:
  - Gate A: Rust tests stable (2 consecutive)
  - Gate B: NAPI smoke stable
  - Gate C: TS dual-path stable

### T10: v0.2.0-rc notes + rollback plan
- Owner: Memphis
- Priority: P0
- KPI: release candidate checklist complete
- Risk: poor handoff/documentation
- Rollback: keep on `-rc` without promotion
- DoD:
  - `docs/V0.2.0-RC-CHECKLIST.md`
  - explicit rollback steps

---

## Global quality gate (every merge)
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `cargo test --workspace` (once Rust added)

## Out of scope for P0
- Full vault cryptography implementation
- Full TUI Nexus implementation
- MCP advanced integration

## Success condition
At end of P0, project has a real Rust/NAPI backbone entry that is testable, reversible, and does not break current TS runtime.

## Phase 0 closure checklist (2026-03)
- [x] `crates/memphis-embed` present with deterministic skeleton tests
- [x] deterministic combined build path (`npm run build:rust` + `npm run build`)
- [x] minimal chain migration command path (`chain import_json --file <path>`)
- [x] closure criteria documented in `docs/PHASE0-CLOSURE-CRITERIA.md`

## Deferred execution update (2026-03-09)

### Item 2 — memphis-embed pipeline
**DONE**
- deterministic local embedding provider implemented (`EmbeddingProvider` + `LocalDeterministicProvider`)
- provider adapter boundary implemented with real external path (`EmbedMode::Provider("openai-compatible")`)
- working embed store/query pipeline (`EmbedPipeline::upsert/search/clear`)
- NAPI bridge exposure for store/search/reset (`embed_store`, `embed_search`, `embed_reset`)
- TS bridge path for runtime roundtrip (`rust-embed-adapter.ts` + CLI `embed ...`)
- tests: rust unit tests + NAPI roundtrip test + TS adapter roundtrip test
- docs: config/limits/ops in `docs/EMBED-PIPELINE.md`
- safe external fallback: remote provider errors degrade to local deterministic provider without pipeline crash
- tuned retrieval path (`embed_search_tuned`) and benchmark harness (`npm run bench:retrieval`)

**REMAINING**
- deeper provider coverage beyond openai-compatible (vendor-specific adapters)
- larger benchmark corpus and CI trend gates for retrieval quality

### Item 3 — higher phase catch-up

#### 3a) Providers + Ask
**DONE**
- `ask` command alias added to CLI with provider/model controls and JSON output parity
- strategy routing input (`--strategy default|latency-aware`) wired into orchestration
- unit test added (`tests/unit/cli.ask-doctor.test.ts`)

**REMAINING**
- multi-turn ask session UX and context window controls
- provider capability matrix + dynamic model routing policies

#### 3b) TUI/UX path
**DONE**
- `--tui` framed output mode for `ask/chat` for operator readability
- unit test added (`tests/unit/cli.tui.test.ts`)

**REMAINING**
- interactive full-screen TUI (history, shortcuts, stream view)
- richer status widgets (provider retries/failover trace + embed mode indicator)

#### 3c) onboarding/install path
**DONE**
- `doctor` command added with onboarding diagnostics (bridge/env/pepper checks)
- `onboarding wizard` command added (checklist/progress output)
- onboarding doc added (`docs/ONBOARDING-INSTALL.md`)

**REMAINING**
- one-shot bootstrap script for host prerequisites
- guided first-run with generated `.env` profiles and validation hints
