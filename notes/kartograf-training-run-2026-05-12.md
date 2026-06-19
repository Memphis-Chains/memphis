# Kartograf training run — 2026-05-12

**Operator:** Marcin (Wodzu)
**Operator role this session:** observer
**Coder B (this agent) role:** runs training + documents every manual step + decision so the v2 `/nightly` skill can automate them

## Purpose of this document

Dual purpose:
1. **Operator log** — what's happening right now, current state, what to expect.
2. **Skill blueprint** — every manual step + decision I make here becomes a checklist item for the v2 training proposer + skill catalog entry. The aim is that the next training run does NOT need Coder B to babysit; Memphis itself proposes, checks pre-flight, spawns, monitors, surfaces verdict.

## Pre-flight findings

### F1. Python ML stack lives in a venv, not system python3

- Path: `/home/memphis/.venvs/memphis-train/bin/activate`
- Has: torch, transformers, peft
- **Missing: bitsandbytes** — train.py uses it for 4-bit ModernBERT QKV. Falls back to BF16 with frozen base if absent.

**Skill blueprint:**
- Add doctor check `ta15-kartograf-train-env`: verifies venv exists + `python3 -c "import torch, transformers, peft, bitsandbytes"` clean. Warn on missing bnb (full mode less safe).
- v2 proposer pre-flight refuses full mode if bnb missing and GPU < 4 GB free. Smoke mode allowed without bnb.

### F2. Signing seed is operator-stashed at `~/.memphis/kartograf/signing-seed.bin`

- Discovered location, not documented in repo.
- 32 raw bytes (Ed25519 seed).
- Operator-controlled — Memphis daemon does NOT manage this.

**Skill blueprint:**
- v2 proposer payload defaults `signingSeedFile: ~/.memphis/kartograf/signing-seed.bin`.
- Doctor check `ta16-kartograf-signing-seed`: file exists + is 32 bytes + chmod 0600. Warn if any check fails.
- If seed missing, v2 emits `signing_seed_missing` insight with operator-action: `openssl rand 32 > ~/.memphis/kartograf/signing-seed.bin && chmod 0600 ~/.memphis/kartograf/signing-seed.bin`.

### F3. Corpus convention: `~/.memphis/kartograf/corpus/<version>/`

- Current active: `v4` (mtime 2026-05-11 13:45 — ~32h old).
- Files: `corpus-v1-summary.json` (schema name kept v1 across corpus versions), `eval-pairs.jsonl`, `eval.jsonl`, `pairs.jsonl`, `train.jsonl`, `zone-labels.json`.

**Skill blueprint:**
- v2 proposer scans `~/.memphis/kartograf/corpus/v*` and picks the highest-numbered version where `corpus-v1-summary.json` exists.
- Doctor check `ta14-kartograf-training` (already planned) sub-asserts: corpus age ≤ 14d, summary file ≤ 7d for "fresh".
- Corpus rebuild stays manual (build-time tool). Skill emits `corpus_rebuild_proposal` if `>7d`.

### F4. GPU memory pressure baseline

- GTX 960, 4096 MiB total, 1029 MiB free at pre-flight time.
- Single competitor: `whisper-server-venv/python3` using 40 MiB. The remaining ~3 GB is non-CUDA framebuffer / driver overhead, not reclaimable from userspace.
- **Realistic CUDA workload budget: 1 GB.**

**Skill blueprint:**
- Doctor check `ta17-kartograf-gpu-pressure`: warn if `nvidia-smi --query-gpu=memory.free` < 2048 MiB, refuse if < 1024 MiB.
- v2 proposer refuses full mode if free < 2 GB.
- Smoke mode budget: forward batch = 6 samples × 128 tokens × ModernBERT-base ≈ ~700 MiB. Fits in 1 GB free.

### F5. Backup state pre-training

- Active checkpoint slug: `45c3d81e038a` at `~/.memphis/kartograf/checkpoints/45c3d81e038a/`.
- Existing artifacts: checkpoint.json, model.onnx, tokenizer.json (verified install).
- **No `.prev/` backup directory yet** — this is the first install of an active checkpoint, so rollback baseline is the absence of any prior install.

**Skill blueprint:**
- v2 install runner (deferred to v3 per plan addendum) backup-before-rmSync — covered by `src/kartograf/rollback.ts:backupCurrentCheckpoint`. First-time install path returns null (no-op, correct).

---

## Decision tree for THIS run

**Smoke mode first (50 steps, ~5 min, max_length=128, batch=4).**

Goals:
1. Validate pipeline end-to-end with current corpus + venv state.
2. Confirm GPU memory budget (1 GB realistic free).
3. Produce a viable but disposable envelope — operator does NOT install it (smoke artifacts are placeholder per train.py:11-19).
4. Log every step the v2 skill needs to know.

**If smoke succeeds → assess full mode viability.**

- If GPU free > 2 GB after smoke completes → proceed with full mode (3 epochs, ~4-8 h on GTX 960). Operator decides whether tonight or later.
- If GPU free ≤ 2 GB OR bnb still missing → defer full mode, emit insight to operator: "smoke succeeded, full mode blocked on env: install bitsandbytes + free GPU memory".

---

## Run log (real-time)

(appending as I go)

### 2026-05-12 ~21:35 — pre-flight complete

Status: GREEN for smoke, AMBER for full (bnb + GPU pressure).

### Next step: invoke smoke training

```bash
source /home/memphis/.venvs/memphis-train/bin/activate
mkdir -p /tmp/karto-smoke-2026-05-12
python3 /home/memphis/memphis/tools/training/train-kartograf.py \
  --corpus ~/.memphis/kartograf/corpus/v4 \
  --out /tmp/karto-smoke-2026-05-12 \
  --signing-seed-file ~/.memphis/kartograf/signing-seed.bin \
  --mode smoke \
  --status-file /tmp/karto-smoke-2026-05-12/status.json
```

Notes:
- Out dir under `/tmp` so it doesn't pollute `~/.memphis/kartograf/staging/` until verified.
- `--status-file` flag is the Phase 2 wiring (still in worktree from earlier work) — verifies the wiring end-to-end.
- After completion: inspect status.json + envelope, do NOT install (smoke produces placeholder ONNX).

Background launch + monitor.
