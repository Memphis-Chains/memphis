# Phase 0 findings — 2026-04-21

Deep online research + Memphis codebase scan performed before Q1 execution of `Y1-2026-05-to-2027-05.md`. Purpose: validate plan assumptions against reality before any Q1 PR lands.

## Research deltas

### memvid project (2026 state)

- **Upstream alive.** `memvid-core` on crates.io at v2.0.139 (2026-03-13), Apache-2.0, active release cadence.
- **`.mv2` format v2** is a complete Rust rewrite (10-100× perf vs v1 Python). Single-file memory layer with embedded WAL, data segments, Tantivy lex index, HNSW vec index, time index, TOC footer.
- **`.mv2e` encrypted variant** already in spec — streaming encryption auto-detects via header byte.
- **`memvid/claude-brain`** (MIT, v1.0.7, Jan 2026, 458 stars) is a reference integration for Claude Code — Rust core + TS/JS wrapper, same architecture as Memphis. Provides `/mind` command vocabulary. Consumer-study target for Memphis's own `.mv2` adapter.

**Delta vs original plan.** Plan v1 classified memvid-core as `vendored-frozen` in `vendor/memvid-core/`. Phase 0 reclassifies to `stable-platform` — pin `memvid-core = "2.0"` in `Cargo.toml`, bump on deliberate review. Vendoring a dormant project makes sense; freezing an active one means missing perf/bug fixes. "Own-the-stack" principle preserved: bumps are PR decisions, not Dependabot auto-merge.

### OpenMythos (2026 state)

- **MIT** (confirmed — README was ambiguous). Kye Gomez, `kyegomez/OpenMythos`.
- **Architecture**: Recurrent-Depth Transformer (RDT) from-scratch, research stage.
- MarkTechPost (2026-04-19): claim "770M ≈ 1.3B transformer" — ambitious but not production-proven on fine-tune workloads.
- **Not a drop-in HF trainer replacement.** Optimized for RDT research, not LoRA on existing base checkpoints.

**Delta vs original plan.** Plan v1 put OpenMythos on the Q3 critical path for training. Phase 0 **demotes OpenMythos to Y2 research arm** — Q3 uses `HF transformers + peft + bitsandbytes` as training substrate on a standard non-instruct base. OpenMythos Rust rewrite stays as N29 stretch (Y2).

### Base model landscape (2026)

- **Qwen3 dense bases** all Apache-2.0: 0.6B, 1.7B, 4B, 8B, 14B, 32B — all non-instruct variants available.
- **Mistral Small 4** (2026-03) Apache-2.0, 256K context.
- **Gemma 3** — Google-license (not pure Apache); excluded for commercial-fork safety.
- TinyLlama-1.1B (2024 vintage) objectively aged.

**Delta vs original plan.** Plan v1 made TinyLlama-1.1B-base the primary pick. Phase 0 promotes **Qwen3-0.6B-base as primary** (pointer/router task is narrow enough that smallest Qwen3 suffices on 4 GB VRAM), Qwen3-1.7B-base as capacity upgrade path, TinyLlama-1.1B-base as escape floor only.

### WatraLLM role (operator-locked 2026-04-21)

WatraLLM Y1 base is **pointer/router**, not chat agent:
- Input: natural-language query.
- Output: structured JSON pointer `{ chain, selector, reasoning, confidence, alternatives? }`.
- No tool invocation, no chain writes, no actions.
- Paranoid-tier output by construction (`AutonomyMode='paranoid'` hard-coded at router boundary).
- Censure-free base + paranoid permission gate = safe-by-construction.

**Delta vs original plan.** Plan v1 described WatraLLM as a new entry in the LLM provider cascade (`src/providers/watra-local.ts`). Phase 0 rewrites as separate pointer service (`src/watra/router.ts`) + new tier-0 read tool `memphis_watra_pointer`. Training corpus narrows from "operator's chains as general chat" to "Memphis structure knowledge + query/pointer pairs".

### HuggingFace datasets ecosystem

- `datasets.load_dataset()` convention stable for JSONL-per-event formats.
- No new mainstream format expected to replace before 2026-Q2.

**No delta.** Trajectory PR D (HF-dataset format) stays as planned.

### Matrix HMAC reference implementations

- Multiple Synapse / Matrix-federation deployments ship application-layer HMAC patterns.
- Reference pattern: HMAC-SHA256 over peer-pair bootstrap, vault-backed key storage. Exactly what plan N14 describes.

**No delta.** Q3 Workstream D proceeds as planned.

## Memphis codebase scan

Ran against main at SHA `HEAD` on 2026-04-21 post-PR #232 merge. Full inventory of `throw new Error('not yet'|'not available'|'not populated'|'unavailable')`:

### Nadpiski N1-N7 verification

| N | Claim | Verified | Correction |
|---|-------|----------|------------|
| N1 | `fallback.ts:55,66,98` three throw-stubs | ✓ | none |
| N2 | `memory.ts:290` TODO vault-encrypt + plaintext archive | ✓ | none |
| N3 | `installer.ts:36-38` stale "skeleton" docstring | ✓ | none |
| N4 | `README.md:51` "coming soon" for shipped command | ✓ | none |
| N5 | 5/37 tools have `inputSchema` (decisions/reflections/patterns/system scan) | ✓ | 5 confirmed (lines 41, 54, 68, 84, 98); 32 handlers pending |
| N6 | `setup-matrix.ts:480` exits 0 despite `pilotReady: false` | ✓ | none |
| N7 | Two `as any` container escapes | ✓ | none |

### Not-nadpiski-but-worth-noting

- **`rust-chain-adapter.ts`**: 7 defensive `throw new Error('X not available in rust bridge')` at lines 287, 304, 364, 380, 394, 404, 417, 435. These are legitimate fail-closed guards when Rust bridge status reports unavailable — NOT nadpiski. Worth surfacing through `memphis doctor` as "rust bridge: 7/7 APIs available ✓" for operator visibility (minor Q1 fold-in).
- **`vault_init_full unavailable`** at `rust-vault-adapter.ts:489`: legit — throws only when both `newContract.vault_init_json` AND `legacyContract.vault_init_json` are absent.

### Infrastructure readiness

- `crates/memphis-core/src/signature.rs` uses `ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey}` — Ed25519 TOC signing needs zero new crypto code.
- Cargo workspace: 7 crates (`memphis-case-index|core|embed|napi|operator|tui|vault`), `resolver = "2"`. Adding `memphis-export` is clean.
- `vendor/` directory does not exist — green-field for any vendored snapshots (none required Q1 after memvid-core reclassification).
- `src/trajectory/schema.ts` + `index.ts` state matches plan: schema-only, PRs B-E pending.
- `src/federation/matrix/client.ts:19-23` deferred key-exchange comment present; `FederationTrustMode` enum still has `'public-deferred'` literal.

## Plan deltas applied

Five deltas folded into `Y1-2026-05-to-2027-05.md`:

- **D1.** memvid-core: `stable-platform` (crates.io pin v2.0) instead of `vendored-frozen`.
- **D2.** Phase 0 spec: add `memvid/claude-brain` source study as reference architecture (MIT, matching stack).
- **D3.** OpenMythos: demoted to Y2 research arm. Q3 training pipeline = pure HF + `peft` + `bitsandbytes`.
- **D4.** Base model primary: Qwen3-0.6B-base (was TinyLlama-1.1B). Upgrade path Qwen3-1.7B-base. Escape floor TinyLlama-1.1B-base.
- **D5.** WatraLLM role locked: pointer/router service, not chat provider slot. `src/watra/router.ts` + `memphis_watra_pointer` tool (tier-0 read). Paranoid-tier output by construction. Tool-use expansion explicit Y2 scope.

## Sources

- [memvid/memvid GitHub](https://github.com/memvid/memvid)
- [memvid/claude-brain GitHub](https://github.com/memvid/claude-brain)
- [memvid-core crates.io v2.0.139](https://crates.io/crates/memvid-core)
- [kyegomez/OpenMythos GitHub](https://github.com/kyegomez/OpenMythos)
- [Qwen3 HuggingFace collection](https://huggingface.co/collections/Qwen/qwen3)
- [MarkTechPost on OpenMythos 770M≈1.3B claim, 2026-04-19](https://www.marktechpost.com/2026/04/19/meet-openmythos-an-open-source-pytorch-reconstruction-of-claude-mythos-where-770m-parameters-match-a-1-3b-transformer/)
