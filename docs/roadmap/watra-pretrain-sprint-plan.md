# WatraLLM pre-train + nightly Watrowanie — Sprint Plan (2026-04-22)

> **Status.** Operational sprint plan for the next ~6 months. Supersedes the generic Y1-2026-05-to-2027-05.md workstream ordering. That doc stays as long-term strategic reference; this is what we execute next.
>
> **Core decision (operator-confirmed 2026-04-22):** WatraLLM is **both pre-trained + nightly-adapted**. We pre-train on Memphis-structure + safety + tools + skills-creation + code-safety corpus. Operator then runs nightly Watrowanie on their own chains to adapt to personal use-cases. Pre-train makes the model **usable from day 0**; Watrowanie makes it **personal over time**.
>
> **Hardware target:** operator runs on 4 GB VRAM + CPU offload. Training happens on better hardware (ours); inference + nightly incremental on operator's box.
>
> **Model role (broader than pointer/router):** WatraLLM is the **basic steering layer** for Memphis. It knows the runtime from the inside — structure, tool registry, safety guards, self-modify drills, skills creation API. It **also optionally replaces or supports `memphis-embed`** (dual-role: LLM for steering + embedding provider for semantic search). No cloud. All paranoid-tier-gated.

## Role revision

### What WatraLLM IS in this plan

1. **Pointer/router** — given a query, emit `{ chain, selector, reasoning, confidence }` pointing primary LLM at the right chain/block (original Q3 scope, retained).
2. **Memphis-structure expert** — knows 8 chains, block schema, 37 tools, 5 cognitive modes, vault contract, federation trust modes, self-update paths. Can answer "how do I add a skill?" or "which chain does X live in?" locally.
3. **Safety-aware code steersman** — knows about signed-block gate, offline-invariant gate, `.append.lock`, chain-continuity hash, paranoid tier, Rust-bridge fail-closed pattern. When asked to modify code, proposes changes that respect these invariants.
4. **Skills creation guide** — knows the skills marketplace API + creator workflow + example skill shapes. Can scaffold skill boilerplate.
5. **Embed model replacement/support** — `memphis-embed` crate adds `WatraLlmProvider` variant. Last-hidden-state embeddings from the same ~1-2B model. No separate embedding model needed in the stack. (Decision point Sprint 1: full replacement vs dual-role with fallback.)

### What WatraLLM IS NOT in this plan

- Not a chat agent (no tool invocation, no writes, no actions)
- Not cloud-hosted (strictly local inference, all variants)
- Not censure-free as feature (base is non-instruct / minimal alignment; paranoid-tier gate makes it safe regardless of base)
- Not replacing the primary LLM (Anthropic/OpenAI/Ollama remain for heavy reasoning; WatraLLM is the router/steersman layer)

## Sprint plan — 14 sprints, ~7 months

Each sprint = 2 weeks. Solo operator pace. Planned deliverables per sprint. Buffer built into Phase E for slip.

### Phase A — Pre-train foundation (Sprint 1-6, ~12 weeks)

Core priority. Ship criterion at end of Phase A: **operator downloads Memphis, model is in the package, `memphis chat --provider watra-local --offline` answers Memphis questions accurately**.

#### Sprint 1 — Architecture decisions + Phase 0 prep (2 weeks)

**Goal:** resolve open architectural questions before writing training code.

- [ ] **Base model decision.** Candidates: Qwen3-0.8B-base (fits 4 GB VRAM trivially), Qwen3-1.7B-base (better quality, tighter fit), Bielik-mini (Polish-native, if distilled variant exists and permissive license verifies). Doc: `docs/dev/WATRA-BASE-DECISION.md`.
- [ ] **Embed architecture decision.** Full replacement of `memphis-embed` providers OR dual-role (WatraLLM + existing provider fallback). Impact analysis on retrieval quality benchmarks. Doc: `docs/dev/WATRA-EMBED-STRATEGY.md`.
- [ ] **Training stack decision.** `transformers` + `peft` + `bitsandbytes` standard stack vs Unsloth (2-5× faster QLoRA). License check on Unsloth (Apache 2.0 per search). Doc addendum in `WATRA-BASE-DECISION.md`.
- [ ] **Corpus scope definition.** 5 corpus categories: Memphis structure, safety/drills, code-modification patterns, tools API, skills creation. Target sizes + synthesis strategy. Doc: `docs/dev/WATRA-CORPUS-SPEC.md`.
- [ ] **Evaluation harness spec.** Held-out query sets per corpus category + metrics. Doc: `docs/dev/WATRA-EVAL-SPEC.md`.
- [ ] **Parallel: ship v1.5.0 polish.** N1-N7 + Bug 3 + docs refresh. Not blocking pre-train work but runs concurrently.

**Sprint 1 ship:** 4 docs committed to `docs/dev/`; v1.5.0 patch release tagged.

#### Sprint 2 — Training corpus v1 generation (2 weeks)

**Goal:** produce first training corpus across all 5 categories. Target ~3000 pairs.

- [ ] **Corpus 1: Memphis structure (~800 pairs).** Auto-generate from code introspection:
  - Walk `src/gateway/tool-registry.ts` → pairs like `{ query: "how do I journal?", answer: "use memphis_journal tool, tier-0, writes to journal chain, inputSchema: { content, tags?, approval_request_id? }" }`
  - Walk `crates/memphis-core/src/block.rs` → pairs about block schema, chain types, signing
  - Walk `src/cognitive/modes.ts` → pairs about 5 modes A-E
  - Walk `docs/dev/*.md` → extract architectural claims as Q/A pairs
- [ ] **Corpus 2: Safety & drills (~600 pairs).** From `docs/runbooks/*.md`, `src/security/*.ts`, test suites:
  - "what happens if I self-modify without snapshot?" → "boot-failure auto-revert kicks in (Phase 2.3, PR #124); but always use `memphis self-modify --snapshot` first"
  - "can I write to chains without the append-lock?" → "no; `.append.lock` file is acquired before hashing; race conditions corrupt chain integrity"
  - Adversarial prompts testing paranoid tier enforcement
- [ ] **Corpus 3: Code-modification safety (~600 pairs).** From git log + PR patterns:
  - Before/after pairs showing how each Codex round fix kept the invariant
  - "how to add a new CLI command without breaking the dispatcher?" → pattern from `docs/dev/` + code example
  - "how to extend a chain schema?" → migration framework #126 reference + code example
- [ ] **Corpus 4: Tools API (~600 pairs).** For each of 37 tools:
  - "what does memphis_X do?" → concise answer
  - "when should I use memphis_X vs memphis_Y?" → discriminator
  - Example inputSchema usage (for the 5 tools that have schema; placeholder for 32 others pending N5)
- [ ] **Corpus 5: Skills creation (~400 pairs).** From skills marketplace docs + existing skill examples:
  - "how do I write a skill?" → scaffold + conventions
  - "what's the skill manifest shape?" → example
  - "how do I test a skill before publishing?" → workflow
- [ ] **Human review pass.** Sample 10% of each category, hand-review for accuracy + helpfulness.

**Sprint 2 ship:** `tools/training/corpus/v1/` directory with 5 JSONL files + `README.md` describing provenance per pair.

#### Sprint 3 — First training run + baseline eval (2 weeks)

**Goal:** train v0.1 WatraLLM; measure accuracy on held-out eval set. No expectation of production quality; we're measuring baseline.

- [ ] **Training pipeline scaffolding.** `tools/training/finetune.py` (HF + peft QLoRA, 4-bit base via bitsandbytes, gradient checkpointing, CPU offload). Checkpoint save format.
- [ ] **Training run v0.1.** Full corpus v1, 1-2 epochs, LoRA rank 16, target adapter ~100-200 MB.
- [ ] **Evaluation harness.** `tools/training/eval-watra.py` runs held-out queries per category, reports accuracy + confidence calibration + category breakdown.
- [ ] **Baseline measurement.** Pre-training (zero-shot with base model + system prompt) vs post-LoRA-training accuracy. Gap analysis per category.
- [ ] **Training run log.** Commit full training run metadata (base model SHA, corpus hash, epochs, loss curve, eval report, adapter size) to `tools/training/runs/v0.1/`.

**Sprint 3 ship:** v0.1 LoRA adapter + eval report showing category-level accuracy. Likely 50-65% on non-trivial categories; good enough to guide Sprint 4 corpus expansion.

#### Sprint 4 — Corpus v2 + retrain (2 weeks)

**Goal:** address eval gaps from Sprint 3 with targeted corpus expansion.

- [ ] **Gap analysis from v0.1.** Which categories scored lowest? Which query types failed? Which were marginal?
- [ ] **Corpus v2 — expand weak categories.** Target ~5000 pairs total after expansion. Priority to safety and code-safety (if those scored low, they're product-breaking).
- [ ] **Codex + trainer input integration.** **This is where the external-review loop enters.** Operator pastes Codex review findings + trainer suggestions; I triage into corpus additions or training config changes.
- [ ] **Training run v0.2.** Retrain on v2 corpus, same LoRA config or tuned if training log suggests.
- [ ] **Eval v0.2.** Target: ≥70% accuracy on all categories, ≥80% on safety.

**Sprint 4 ship:** v0.2 adapter + eval report. If ≥70% everywhere, proceed to Sprint 5. If not, allocate Sprint 5 partially to corpus v3.

#### Sprint 5 — Embed integration (2 weeks)

**Goal:** wire WatraLLM as embedding provider in `memphis-embed` crate. Decide full-replacement vs dual-role.

- [ ] **Implement `WatraLlmProvider`** in `crates/memphis-embed/src/pipeline.rs`. Embedding = last hidden state of the LoRA-merged model, pooled (mean or last-token).
- [ ] **Retrieval benchmark.** Existing `memphis-embed` benchmark suite (if any) or synthesize one. Compare WatraLLM embeddings vs `LocalDeterministic` vs `OllamaProvider` on Memphis chain search tasks.
- [ ] **Architecture decision finalized.** Based on benchmark numbers:
  - **Full replacement** if WatraLLM ≥ current embed quality and latency is acceptable
  - **Dual-role** if WatraLLM is good enough for some queries but current provider needed as fallback
- [ ] **`memphis-embed` integration.** Wire `EmbedMode::WatraLLM` variant; runtime config via `RUST_EMBED_MODE=watra-local`.
- [ ] **`memphis-embed` tests.** Round-trip tests with WatraLLM backend.

**Sprint 5 ship:** WatraLLM usable as embed provider in `memphis-embed`. Benchmark report committed. Architecture decision documented.

#### Sprint 6 — Package + integration (2 weeks)

**Goal:** WatraLLM shipped in Memphis installer. Operator downloads Memphis, WatraLLM is there, activated.

- [ ] **GGUF conversion.** LoRA adapter → merge into base → convert to GGUF Q4_K_M via llama.cpp. Target size: 400-800 MB.
- [ ] **Installer baking.** `install.sh` downloads GGUF as part of setup (or includes it in npm package if size allows). `memphis init` registers with local Ollama.
- [ ] **`src/watra/router.ts`** service implementation (the pointer/router surface from the original Q3 plan, now ready to consume the actual model).
- [ ] **`memphis_watra_pointer`** tool registered in `src/gateway/tool-registry.ts` + MCP handler in `src/mcp/tools/watra-pointer.ts`.
- [ ] **Paranoid-tier gate.** Hard-coded in `router.ts` via existing `src/security/` autonomy-mode machinery.
- [ ] **CLI surface.** `memphis watra query "<text>"`, `memphis watra list`, `memphis watra use <sha>`, `memphis watra verify <sha>`.
- [ ] **Integration tests.** Adversarial prompts (action-field injection) + pointer accuracy smoke.
- [ ] **Docs.** `docs/operator/watra-setup.md` (operator-facing), `docs/dev/WATRA-INTEGRATION.md` (developer-facing).

**Sprint 6 ship:** `memphis watra query "how do I add a skill?"` works offline, returns useful pointer. Fresh-install smoke test passes.

**End of Phase A.** Pre-trained WatraLLM shipped. Every operator who installs Memphis gets it.

### Phase B — Nightly Watrowanie (Sprint 7-8, ~4 weeks)

User-specific adaptation. Model evolves to match operator's actual chain content.

#### Sprint 7 — Watrowanie pipeline (2 weeks)

**Goal:** nightly cron job runs on operator's box, does incremental LoRA training on new chain blocks.

- [ ] **`tools/training/watrowanie.py`** — incremental training script. Reads chain delta since last checkpoint (tracked in `~/.memphis/watra/state.json`), generates query/pointer pairs from the delta (using primary LLM OR pre-trained WatraLLM for generation), runs 1 mini-epoch LoRA on top of previous adapter.
- [ ] **Skip-gate.** `WATRA_MIN_BLOCK_DELTA` env (default 50). Below threshold → log skip, exit 0.
- [ ] **Regression guard.** Run eval before swap; if new checkpoint worse than active → keep active, log.
- [ ] **Atomic symlink swap.** `~/.memphis/watra/active -> checkpoints/<sha>/`. Rollback trivial.
- [ ] **On-chain log.** New `watrowanie_runs` chain (register in `crates/memphis-core/src/block.rs` BlockType enum + TS chain-adapter). Each run = one block with `{ baseSha, blockDelta, outputSha, outputSize, wallClockSec, hardwareProfile, pointerAccuracy, regressionDetected }`.
- [ ] **CLI.** `memphis watra train --auto` (cron entry), `memphis watra train --dry-run`, `memphis watra history`.

**Sprint 7 ship:** `memphis watra train --auto` runs end-to-end on a test host. On-chain log verified.

#### Sprint 8 — Cron installation + operator UX (2 weeks)

**Goal:** nightly runs automatically without operator intervention.

- [ ] **Timer install.** `memphis watra install-timer` generates:
  - Linux/WSL: `systemd --user` unit at `~/.config/systemd/user/memphis-watrowanie.{service,timer}`
  - macOS: `launchd` plist at `~/Library/LaunchAgents/chains.memphis.watrowanie.plist`
  - Windows: Scheduled Task via `schtasks.exe`
  - Schedule: 03:00 local
- [ ] **Disable flag.** `MEMPHIS_WATROWANIE_DISABLED=1` bypass cron for ops who don't want it.
- [ ] **TUI integration.** Status bar segment: `Watra v1-a3f2 | acc 0.78 | last 03:12 +47 blocks`. Details panel with last 10 runs.
- [ ] **Doctor check.** `memphis doctor` reports Watrowanie timer status + last-successful-run + regression flag.
- [ ] **Docs.** `docs/operator/watra-nightly.md` — how it works, how to disable, how to inspect history, how to roll back.

**Sprint 8 ship:** Fresh install on test host → `memphis watra install-timer` → next night, training runs, next morning, new checkpoint live. Operator didn't touch a thing.

**End of Phase B.** Model ships pre-trained + adapts nightly. Core value prop delivered.

### Phase C — Domain chains (Sprint 9-10, ~4 weeks)

**Only after Phase A-B are solid.** Mechanic/hobbyist domain chains stack on top of working pre-trained WatraLLM. Model already knows Memphis; now Memphis grows new chain types the model doesn't know → nightly Watrowanie teaches it.

#### Sprint 9 — Domain chain schema + tools (2 weeks)

- [ ] **Extend `BlockType` enum** in `crates/memphis-core/src/block.rs`: `Client`, `Vehicle`, `Job`, `Part`, `Note` (+ any others after user interviews).
- [ ] **Migration framework.** Apply #126 schema migration for existing operators on upgrade.
- [ ] **Chain directory conventions** in `src/infra/storage/chain-adapter.ts`.
- [ ] **Domain tools.** `memphis_client_add`, `memphis_vehicle_attach`, `memphis_job_log`, `memphis_part_order`, `memphis_note_jot` (voice-friendly names).
- [ ] **Relationship model.** Client ↔ Vehicle ↔ Job ↔ Parts graph. Use existing `memphis-case-index` (already SQLite) or extend.
- [ ] **Tests.** Chain round-trip, migration correctness, tool integration.

#### Sprint 10 — Voice-first + photo UX (2 weeks)

- [ ] **Voice input.** Whisper STT. Option A: vendored `whisper.cpp` (offline, CPU-friendly). Option B: Ollama whisper variant. Decision in Sprint 9.
- [ ] **Hold-to-record.** `memphis note --voice` CLI + TUI keybind + eventually HTTP endpoint for mobile companion.
- [ ] **Photo attachment.** `memphis note --photo <path>`. Photo embedding via CLIP-like (candidate: add to `memphis-embed`); if photo-embed is too much scope, fallback to text-only tags + photo stored in chain.
- [ ] **Gallery view in TUI.** New screen or within Memory screen.

**End of Phase C.** Memphis works for mechanic/hobbyist domain. Nightly Watrowanie starts learning user's client/vehicle/job vocabulary.

### Phase D — Watra-Pack USB (Sprint 11-12, ~4 weeks)

Showcase vehicle. Alpine + Ollama + Memphis + pre-trained WatraLLM GGUF all on bootable USB.

#### Sprint 11 — Alpine + Ollama + GGUF (2 weeks)

- [ ] **Alpine minimal ISO** custom build. apk packages: ollama (from community repo), node22, rust toolchain.
- [ ] **apkovl overlay** baking Memphis dist + Ollama model registry with WatraLLM GGUF pre-registered.
- [ ] **Persistent partition** for `~/.memphis/` on same USB.
- [ ] **Boot test.** VM + real USB on x86 laptop target 4 GB RAM.

#### Sprint 12 — First-boot flow + GUI decision (2 weeks)

- [ ] **First-boot script.** Generates vault passphrase, calls `memphis init --non-interactive`, launches TUI.
- [ ] **GUI decision** (Tauri vs egui vs stay TUI-only). If GUI: 3 screens — history, new entry (voice), search.
- [ ] **Operator manual PL + EN.**
- [ ] **Flash script.** `scripts/flash-watra-pack.sh` for creating the USB from operator side.

**End of Phase D.** "Przekładam USB → boot → mechanik mówi do mikrofonu → Memphis zapisuje i rozumie" — full showcase-ready.

### Phase E — Showcase + first users (Sprint 13-14, ~4 weeks)

Real humans touch the product.

#### Sprint 13 — Tutorial + first workshop

- [ ] Screencast tutorials PL (5-8 min each): install, first record, search history, nightly training.
- [ ] Workshop #1: 5-10 mechaników/hobbystów w jednym miejscu. Observe. Zbierz top 10 issues.

#### Sprint 14 — Rapid fix + stabilization

- [ ] Patch top 10 workshop findings.
- [ ] Workshop #2: kolejna grupa 5-10 osób.
- [ ] v1.6.0 release. CHANGELOG.

**End of Phase E.** 10-20 active early adopters. Data to argue about monetization, impakt milestones, long-term direction.

## Deferred from this sprint plan

Not in scope for these 14 sprints. Gets picked up after showcase based on feedback:

- Trajectory PR B-E (N8-N11 from Y1 doc) — not blocking MVP, domain chains give us same feedback signal
- `.mv2` full round-trip (N13) — `memvid-core` integration useful for training data portability later, but not for MVP showcase
- M6 embedding cascade unification (N21) — solved indirectly by WatraLLM embed replacement in Sprint 5
- External Q2 security audit (N15) — engage after v1.6.0 stable so reviewer audits a real product
- Matrix public HMAC (N14) — federation GA not relevant for mechanic/hobbyist showcase segment
- Replay + A/B + RLAIF (N18-N20) — Y2 or later, needs dataset volume we won't have yet
- Commercial fork framework (N28) — decision after showcase reveals actual customer profile

## Collaboration protocol

Starting Sprint 2 onwards, Marcin pastes into sessions:
- **Codex review findings** — I triage into corpus additions, training config changes, or code fixes
- **Trainer suggestions** — integrated into training pipeline choices, hyperparameter tuning, eval harness
- **Test Memphis logs** — I trace bugs to source, suggest fixes

My role shifts from "roadmap architect" to "pair-coder + corpus curator + integration wrangler". Full-time engineering mode.

## Risk register

| Risk | Mitigation | Trigger |
|------|------------|---------|
| Pre-train eval <70% even after Sprint 4 corpus v2 | Scope cut: ship with 60% accuracy + label as "experimental"; iterate with nightly Watrowanie | Sprint 4 eval report |
| Base model choice (0.8B vs 1.7B) hits 4 GB VRAM ceiling | Fall back to smaller base or aggressive quantization (Q3_K_M) | Sprint 5-6 packaging |
| Embed replacement quality poor | Dual-role config with existing provider as fallback | Sprint 5 benchmark |
| Watrowanie regression corrupts model | Atomic swap + regression guard + rollback CLI | Sprint 7-8 |
| Domain chains break existing operators on upgrade | Migration framework + explicit upgrade CLI + backup | Sprint 9 |
| Watra-Pack USB boot fails on real hardware | Test matrix: 3+ laptops before Sprint 13 workshop | Sprint 11-12 |
| Workshop users hate the UX | Stop, not ship v1.6.0; iterate with smaller cohort | Sprint 13 |

## Open questions (pogadanka architektury nastąpi po commit)

1. **Base model final pick** — Qwen3-0.8B vs 1.7B vs Bielik-mini vs PlLLuM. What's the tiebreaker? License, Polish quality, VRAM fit, licensing for commercial Y2 fork?
2. **Embed architecture** — full replacement or dual-role? Need benchmark data from Sprint 5 but we should have a hypothesis going in.
3. **Training corpus generation** — Marcin prompts Anthropic for synthetic pairs, or does trainer (external collaborator) provide? Review process?
4. **Domain chains — which 5 exactly?** — `clients`, `vehicles`, `jobs`, `parts`, `notes` as default; but user interviews Sprint 1 may surface different taxonomy.
5. **GUI for Watra-Pack** — TUI-only is risky for blue-collar pros; egui (pure Rust) vs Tauri (web grade). Voice-primary might reduce GUI criticality.
6. **Training hardware** — where does the pre-train actually run? Local GPU (if Marcin has access), cloud rental (single-run budget ~$20-50 per training), or collaborator's machine?

## Immediate next steps (post-commit)

1. Commit + push this plan
2. Pogadanka architektury with Marcin — answer open questions 1-6
3. Ratify sprint plan (may need adjustments post-pogadanka)
4. Start Sprint 1
