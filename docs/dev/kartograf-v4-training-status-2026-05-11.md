# Kartograf v4 Training — Setup Complete

**Generated:** 2026-05-11 morning by Claude Code session.
**Status:** Stack installed + corpus built + pairs mined + smoke test running.

---

## Stack installed (cumulative, this session)

```
~/.local/bin/uv                  uv 0.11.13 (pipx-installed)
~/.venvs/memphis-train/          Python 3.11.15 venv
  ├── torch 2.3.1+cu118          ✓ CUDA, sm_50 in arch_list, Maxwell sm_52 supported
  ├── transformers 4.43.4        compat with torch 2.3 (newer requires torch 2.4 = drops Maxwell)
  ├── peft 0.12.0
  ├── accelerate 0.33.0
  └── sentencepiece, protobuf, datasets

GTX 960 4GB | compute 5.2 | driver 580.142 | CUDA 13.0
```

**Critical constraint:** transformers 4.49+ has ModernBERT but requires torch 2.4+, which drops Maxwell sm_52. So we use transformers 4.43.4 + DeBERTa-v3-large as ModernBERT-equivalent encoder.

## Corpus built (v4)

`~/.memphis/kartograf/corpus/v4/`:

| File | Records | Bytes |
|------|---------|-------|
| `train.jsonl` | 5168 | 12.0 MB |
| `eval.jsonl` | 573 | 1.2 MB |
| `pairs.jsonl` | 5133 (4-neg uniform) | 1.9 MB |
| `eval-pairs.jsonl` | 539 (4-neg uniform) | 305 KB |
| `corpus-v1-summary.json` | — | secret_scan clean, vault_denylist enforced |

**Zone distribution (5741 samples):**
- patterns: 2547 (44.4%) — Rust Book + TS Handbook (from v2 aug)
- journal: 1740 (30.3%) — operator+bot chat conversations (100× growth from v3)
- system: 1321 (23.0%) — Memphis chain blocks
- reflections/decisions/soul/cases/insights/collective/proactive: small tail

**Sources merged:**
- v3 baseline: 3266 train + 523 eval (dedup'd)
- MSE SQLite: 466 (dedup'd from 480)
- Wide-window chat: 1486 (no dups vs v3)

**Pair mining (5159 train pairs):**
- 4140 symbol-similarity (TF-IDF tiebreak)
- 778 git-cooccurrence
- 241 temporal-adjacency
- (Post-filter to uniform 4-neg: 5133 retained)

## Smoke training status

**Issue identified + fixed (this session):**
- Pair-miner emitted 26 pairs with <4 hard_negs (uneven from cross-zone weighting)
- Caused `data.py:283 batch has mixed neg_count` error mid-training (crash @ step 30)
- **Fix applied:** filter pairs.jsonl + eval-pairs.jsonl to 4-neg uniform (26+28 dropped)
- Re-running smoke now (BG task `b194zcbxt`)

**Real measured throughput** (DeBERTa-v3-large + LoRA + grad_ckpt, FP16, BS=4 grad_accum=2 → effective BS=8):
- step time: **~10.4 sec/step**
- GPU memory: **1554 MB peak** (out of 4028 MB — 38% utilization, plenty of headroom)
- loss curve: 4.10 → 3.56 over 30 steps (-13%, healthy InfoNCE+CE descent)

**Time estimate for `--mode full` (3 epochs):**
- iters_per_epoch = 4953 anchors / 4 batch = 1238
- total_steps = 1238 × 3 / grad_accum_2 = 1857
- @ 10.4 sec/step = **5.4 hours**
- VRAM: 1.5-2.5 GB peak (fits 4 GB with headroom)
- Recommended overnight slot or daytime supervised

## Launch command (production training, when operator approves)

```bash
# Requires no sudo. Operator just runs this.
cd ~/memphis

# 1. Verify smoke succeeded first:
ls -la ~/.memphis/kartograf/staging/smoke-v4-deberta/

# 2. Launch full training:
KARTOGRAF_MODEL_ID="microsoft/deberta-v3-large" \
KARTOGRAF_HIDDEN_SIZE=1024 \
KARTOGRAF_LORA_TARGETS="query_proj,key_proj,value_proj" \
nohup ~/.venvs/memphis-train/bin/python tools/training/train-kartograf.py \
  --corpus ~/.memphis/kartograf/corpus/v4 \
  --out ~/.memphis/kartograf/staging/full-v4-deberta-2026-05-11 \
  --signing-seed-file ~/.memphis/kartograf/signing-seed.bin \
  --mode full \
  --hardware "GTX-960-Maxwell-sm52" \
  --distribution-source file \
  > /tmp/kartograf-full-train.log 2>&1 &

# Monitor:
tail -f /tmp/kartograf-full-train.log

# Check VRAM:
watch -n 5 'nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv'
```

Expected outcome after ~5.4h:
- `model.onnx` (signed)
- `tokenizer.json`
- `checkpoint.json` (Ed25519 signature, contains `onnx_sha256`, `tokenizer_sha256`)
- Eval recall@10 score in summary

## Install trained checkpoint

```bash
# After training:
memphis kartograf install \
  --file ~/.memphis/kartograf/staging/full-v4-deberta-2026-05-11/checkpoint.json \
  --source file

# Verify:
memphis kartograf status
memphis doctor 2>&1 | grep ta13-kartograf
```

## Files modified this session

1. `tools/training/kartograf_train/model.py` — env-driven MODEL_ID + HIDDEN_SIZE + LORA targets (default unchanged, ModernBERT-base)
2. `tools/training/kartograf-build-v4.py` (new) — corpus merger
3. `tools/training/gpu_smoke_test.py` + `gpu_smoke_test_v2.py` (new) — capacity benchmarks
4. `tools/training/run_gpu_smoke.sh` (new) — runner wrapper

## Open questions for operator

1. **Pull trigger?** — launch `--mode full` now (5.4h run, can leave running)
2. **Hardware upgrade decision** — GTX 960 works for this, but training Watra LLM requires ≥sm_75 (Turing+). Cost-benefit: rent Vast.ai RTX 3060 ~$1-4 per Watra training run.
3. **Tool-selection head as Phase 2** — separate model trained on `wide-window/curated/tool-selection-{train,eval}.jsonl` (969+241 records). Wait for Kartograf done or parallelize?

## Open issues (not blocking smoke)

- `[train-kartograf] unexpected failure: batch has mixed neg_count (1 vs 4)` — appeared during preflight on FIRST smoke run. After uniform-4-neg filter, should not recur. If it does → patch `data.py:283` to pad/clip mixed batches.
- 206 ambiguous anchors dropped (`4953 usable / 5168 total`) — expected, ambiguous samples need teacher distillation in Phase 1.5 (deferred per spec).
