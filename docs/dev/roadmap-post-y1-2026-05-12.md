# Memphis post-Y1 roadmap — 2026-05-12 snapshot

> **Source**: research + planning session 2026-05-12 wieczór. Captures the backlog AFTER the current sprint (T0-T7 from `.claude/handoff-coder-a-review-queue-2026-05-12.md` REV 5) ships. Mirror of the post-Y1 section from the local plan-file `~/.claude/plans/i-co-widzisz-logical-squid.md` — committed to repo so remote / future agents / cross-device sessions can see it.

## Context

Current Y1 sprint (`handoff REV 5`) closes with T0-T7 + Codex round-N hotfix + operator full-reset milestone. **After** all of those land, the backlog below is the source-of-truth for "what comes next."

Cross-refs:
- Sprint state: GH issue [#147 comment](https://github.com/Memphis-Chains/memphis/issues/147#issuecomment-4435031681)
- TUI app.rs refactor (Tier 1): GH issue [#598](https://github.com/Memphis-Chains/memphis/issues/598)
- Local plan-file: `~/.claude/plans/i-co-widzisz-logical-squid.md` (full Y1 detail, NOT committed)
- Local memory: `~/.claude/projects/-home-memphis-memphis/memory/MEMORY.md` (gitignored)

---

# Post-Y1 roadmap — what comes AFTER current sprint (T0-T7) ships

## Context

Current sprint (handoff REV 5) closes Y1 with: T0 ✅, T1-T7 in queue. After all merged + Codex round-N + operator full-reset milestone, Y1 is officially done. Below is the **post-Y1 backlog** organized by priority and trigger conditions, so we don't lose context between sessions.

## Tier 1 — short-term post-T7 (next 2-4 weeks)

### TUI app.rs surgical split (GH #598)

**Trigger:** T7 merged + B-step verified.

**Scope:** Option-B from issue #598 — carve out `crates/memphis-tui/src/commands.rs` from app.rs (~600-800 LOC moved). 1 PR, pure refactor, no behavior change. After ship: app.rs ~5,800 LOC, new commands land in modular file.

**Owner:** Coder A natural epilog after T7 BIG FINAL.

### Codex round-N hotfix follow-up findings

**Trigger:** Codex review of T1, T2, T3.5, T4, T7 PR comments (post-merge, 1-3h after each).

**Scope:** bundled hotfix PR `hotfix/codex-round-N-2026-05-XX` per Memphis convention (`feedback_codex_bundled_hotfix`). Includes anticipated W1 silent-catch, W2 process.cwd, N1 JSON.parse, plus whatever Codex catches.

**Owner:** Coder A (already in handoff queue as T5).

### Whisper STT systemd debug

**Trigger:** operator action — install missing whisper-server binary in `~/.cache/whisper-server-venv/`, OR diagnose why `memphis-whisper-stt.service` enabled but port 9000 not responding.

**Scope:** operator runs `journalctl --user -u memphis-whisper-stt -n 50`. If venv missing pieces → `pip install -r ...` in venv. If service config bug → patch service unit. Probably 30-60 min once operator decides.

**Owner:** operator + optional Coder A debug PR if config bug.

## Tier 2 — medium-term (1-3 months)

### env-registry migration drip-feed

**Trigger:** none (anytime), or alongside any PR that touches a file with raw `process.env.X` reads.

**Scope:** ~129 raw `process.env.X` reads in production `src/` (excluding tests). Sprint D Phase 3 incomplete. Migration script + ESLint `no-restricted-syntax` rule already exists. Each file migration = small PR, ~30 min.

**Owner:** Any worker, drip-feed style (1-2 files per PR alongside other work).

### TUI voice + image input parity vs Telegram (Tauri-leg coupled)

**Trigger:** Tauri RIGHT-leg starts (per `project_2fold_strategy`).

**Scope:** TUI gets:
- Voice record via ffmpeg microphone capture → Whisper STT (depends on Whisper STT debug above)
- Image paste via clipboard (cross-platform: `arboard` crate for Rust, native paste handlers)

**Owner:** TBD — likely Coder A or specialized Tauri integration agent.

### Soul/seed extension: bedtime intent expansion

**Trigger:** T7 ships with single bedtime intent recognition pattern. Operator wants broader: "weź to na noc", "rano pokaż wyniki", "śpię, pilnuj", etc.

**Scope:** expand NLU patterns in T7.4 + T7.5 skill. Add more intent shapes. Test with operator's natural phrasings.

**Owner:** Coder A, post-T7 polish.

## Tier 3 — long-term (3-6 months)

### Kartograf v2 training (real ONNX export + eval)

**Trigger:** Y1 stable + operator wants better retrieval. Probably 1-2 retrainings worth of data accumulated.

**Scope:** train.py Phase 4 (real ONNX export, currently placeholder) + Phase 6 full-eval rig. Requires operator overnight GPU time (4-8h GTX 960) + bnb=4bit upgrade (CC ≥ 7.5 GPU) OR BF16 fallback acceptance.

**Owner:** operator + auto-pipeline (T7 enabled). Code mostly there (Phase 2-3 placeholder ONNX export); needs real torch.onnx.export integration.

### Memphis-host architecture refactor (post-S4 split)

**Trigger:** TUI app.rs Option-B split shipped (#598). Operator has appetite for more refactor.

**Scope:** continuation of S4 — additional splits:
- `app/extension_host.rs` (Host RPC dispatch)
- `app/input.rs` (input + paste + tokenizer)
- `app/render.rs` (ratatui widgets, consolidated from ui.rs + app.rs)
- `app/state.rs` (App struct + state mutations)

Result: `app.rs` becomes event loop + orchestration only (~1,500 LOC).

**Owner:** Coder A, only if operator green-lights another tech-debt sprint.

## Tier 4 — Y2 (Q1-Q2 2027, intentional defer)

These have GH issues + design docs but are NOT in any current/near-term sprint.

### LeWorldModel integration

**Issue:** none yet (research-stage). Doc: `docs/dev/LEWM-INTEGRATION-PROPOSAL.md`.

**Scope:** new crate `crates/memphis-worldmodel`, NAPI exports, `world_model` chain, `ml-worldmodel` VM primitive. Paper citation placeholder (`2026.XXXXX`).

### Agora federation phases 0-5

**Issues:** #153-158, #161 (Y2 spike, phase 4.5 adversarial sim).

**Scope:**
- Phase 0: design doc (`docs/AGORA-DESIGN.md`)
- Phase 1: L1 Attestations + trust-graph BFS (#154)
- Phase 2: L3 Reviews + weighted reputation (PageRank-style) (#155)
- Phase 3: L2 Stake + ML contracts + payment adapter (#156)
- Phase 4: L4 Discovery (DHT / gossip) (#157)
- Phase 5: Marketplace UX in Tauri (#158)

### Memphis 2-fold strategy RIGHT leg — Tauri GUI

**Issue:** #152 (phase G: Tauri GUI skeleton).

**Scope:** `apps/memphis-gui` — Chat + Memory + Agents views. Separate repo currently at `/home/memphis/memphis-tauri/` (out of memphis-host monorepo).

### Maximum-toolkit research (#44)

**Issue:** #44 — 500+ tools across 12 categories for self-evolving AI runtime. Phase 1-5 in #47-50.

**Scope:** massive research project. Out of any short-term planning. Tracked for visibility.

## Reset milestone

After Y1 sprint queue (T0-T7 + Codex round-N) ships:

**Operator-only action:** full `memphis init` from fresh state.

1. Backup: `tar -czf ~/Backups/memphis-pre-reset-<date>.tar.zst ~/.memphis ~/memphis`
2. Wipe: `rm -rf ~/.memphis/{chains,state,kartograf,backups,*.db,*.jsonl}`
3. Fresh init: `memphis init` (recreates dirs, regenerates operator passphrase prompt)
4. Vault restore: copy provider keys from backup, re-encrypt under new pepper
5. Selective journal restore: cherry-pick journal entries from backup chain that operator wants historic context for
6. Verify all Y1 surfaces: `/tier 3`, `memphis_exec`, vision pipeline, doctor ta14-ta18, bedtime trigger, etc.

**Coder A's role pre-reset:** write `notes/pre-reset-validation-checklist-<date>.md` listing exactly which surfaces operator should verify post-fresh-init. Plus all T1-T7 B-step scripts should work on fresh chain state from block #1.

**Why reset:** clean cut between Y1 v1.x (with block-1853 fork-marker scar) and Y1 v2.0 (fresh chain from #1). Operator-visible "everything ON the new code" validation.

## How to use this section in future sessions

- If new feature request comes in → check if it's already in Tier 1-4 backlog. If yes, that's the scope discussion starting point.
- If sprint capacity opens (operator says "next sprint") → pick Tier 1 items first, then Tier 2 by trigger condition match.
- If operator asks "co potem?" / "what's next after T7?" → reference Tier 1 ordered list.
- Don't pull Tier 4 items forward without explicit operator OK — they have intentional Y2 timing.
