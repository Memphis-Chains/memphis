# tools/training

Build-time tooling for Kartograf + future WatraLLM checkpoints. Scripts here
run **outside the Memphis operator runtime** — they are developer utilities
for generating corpora, running training, exporting ONNX.

Operator installs do NOT need Python. These scripts are only invoked when
producing a new Kartograf checkpoint for release.

## Contents

| Script | Scope | Status |
|---|---|---|
| `kartograf-corpus.py` | Y1 Q1 N37 — walk repo + chains, scan for secrets, label zones, write train/eval JSONL | v1 shipped |
| `kartograf-pair-miner.py` | Y1 Q2 N32 Phase 1 — retrofit corpus with contrastive pairs (git co-occurrence + symbol TF-IDF + cross-zone hard negatives) | Q2 Phase 1 |
| `kartograf-corpus-augment.py` | Y1 Q2 N32 Phase 2.5 — extend v1 corpus with external reference material (Rust Book + TS Handbook + memphis-v5.pl/docs) → corpus v2 | Q2 Phase 2.5 |
| `train-kartograf.py` | Y1 Q2 N32 Phase 2-4 — load corpus+pairs, LoRA fine-tune ModernBERT + two heads, eval rig, ONNX export, sign envelope. `--mode stub` = N37.2 behavior; `--mode smoke` = 50-step proof-of-life; `--mode full` = real run with end-of-epoch eval + best-checkpoint tracking. | Q2 Phase 2-4 |
| `kartograf_train/` package | Y1 Q2 N32 — data loader + model + loss + training loop + eval rig + ONNX export (invoked by `train-kartograf.py`) | Q2 Phase 2-4 |
| `MODELCARD-TEMPLATE.md` | Template for per-release MODELCARD.md (fill in `{{...}}` slots from checkpoint envelope + eval results) | Q2 Phase 4 |

## Usage — corpus pipeline (N37)

```bash
# Default build: runs against local repo + ~/.memphis/chains + writes to
# ~/.memphis/kartograf/corpus/v1/
python3 tools/training/kartograf-corpus.py

# Dry run — print summary only, no files written
python3 tools/training/kartograf-corpus.py --dry-run

# Offline / no-teacher — skip Claude ambiguous labeling (safe for air-gap)
python3 tools/training/kartograf-corpus.py --no-teacher

# Custom paths
python3 tools/training/kartograf-corpus.py \
  --repo-root /path/to/memphis \
  --chains-dir /path/to/chains \
  --out-dir /tmp/corpus-test
```

## Usage — pair miner (N32 Phase 1)

```bash
# Retrofit pairs.jsonl on top of an existing corpus. Additive: does not
# rewrite train.jsonl / eval.jsonl. Bumps summary with pair_count +
# pair_mining_version. Git log results are cached at
# <corpus>/.git-log-cache.json for repeated runs.
python3 tools/training/kartograf-pair-miner.py \
  --corpus ~/.memphis/kartograf/corpus/v1

# Dry run
python3 tools/training/kartograf-pair-miner.py --corpus ~/.memphis/kartograf/corpus/v1 --dry-run
```

## Usage — corpus augmentation to v2 (N32 Phase 2.5)

```bash
# One-time prerequisites: fetch external reference corpora.
mkdir -p /tmp/karto-aug/{src,memphis-v5-pages}
git clone --depth 1 https://github.com/rust-lang/book /tmp/karto-aug/src/rust-book
git clone --depth 1 https://github.com/microsoft/TypeScript-Website /tmp/karto-aug/src/ts-website
# Scrape memphis-v5.pl/docs (19 pages)
while read url; do
  slug=$(echo "$url" | sed -E 's|https://memphis-v5.pl/docs/?||; s|/$||; s|/|_|g')
  [ -z "$slug" ] && slug="index"
  curl -sL --max-time 15 "$url" -o "/tmp/karto-aug/memphis-v5-pages/${slug}.html"
done < <(curl -sL --max-time 15 https://memphis-v5.pl/docs/sitemap.xml \
  | grep -oE '<loc>[^<]+</loc>' | sed 's|<[^>]*>||g; s|docs\.memphis-v5\.pl|memphis-v5.pl/docs|')

# Build v2 = v1 + rust-book + ts-handbook + memphis-v5.
python3 tools/training/kartograf-corpus-augment.py \
  --v1-dir ~/.memphis/kartograf/corpus/v1 \
  --v2-dir ~/.memphis/kartograf/corpus/v2 \
  --rust-book-dir /tmp/karto-aug/src/rust-book/src \
  --ts-handbook-dir /tmp/karto-aug/src/ts-website/packages/documentation/copy/en \
  --memphis-v5-dir /tmp/karto-aug/memphis-v5-pages

# Re-mine pairs against the expanded corpus.
# Two passes are REQUIRED: train-side (default) → pairs.jsonl,
# and eval-side (--source eval) → eval-pairs.jsonl. Without the
# eval pass, retrieval recall@K silently collapses to 0.0 because
# eval anchors have no entries in pairs_by_sha (disjoint train/eval
# split). The trainer falls back to pairs_by_sha if eval-pairs.jsonl
# is missing, but that cross-pool lookup yields zero hits.
python3 tools/training/kartograf-pair-miner.py --corpus ~/.memphis/kartograf/corpus/v2
python3 tools/training/kartograf-pair-miner.py --corpus ~/.memphis/kartograf/corpus/v2 --source eval
```

## Usage — training (N32 Phase 2-4)

```bash
# Stub: CI-friendly. No ML deps actually executed.
python3 tools/training/train-kartograf.py --mode stub \
  --corpus ~/.memphis/kartograf/corpus/v1 \
  --out /tmp/karto-stub --signing-seed-file <seed>

# Smoke: 50 real optimizer steps, proof-of-life. Any loss decrease is pass.
python3 tools/training/train-kartograf.py --mode smoke \
  --corpus ~/.memphis/kartograf/corpus/v2 \
  --out /tmp/karto-smoke --signing-seed-file <(openssl rand 32)

# Full: real run with end-of-epoch eval + best-checkpoint tracking + ONNX
# export. Default 3 epochs, seq=512, grad_checkpointing on (4-8h on GTX 960).
python3 tools/training/train-kartograf.py --mode full \
  --corpus ~/.memphis/kartograf/corpus/v2 \
  --out ~/.memphis/kartograf/checkpoints/run-$(date +%s) \
  --signing-seed-file /path/to/operator-ed25519.seed
```

Full-mode writes alongside `checkpoint.json`:
- `model.onnx` — FP16 ONNX (LoRA merged into base; opset 17; dynamic batch + seq).
- `tokenizer.json` — ModernBERT BPE tokenizer (HF format; consumable by `onnxruntime-node` + `@huggingface/tokenizers`).
- `eval-results.json` — sidecar with the four spec metrics (recall@10, zone_accuracy, ECE, p99 latency) + per-class F1.
If ONNX export fails (known: LoRA + ModernBERT + older opsets), the envelope still signs correctly with placeholder ONNX bytes and `[train] WARN` logs the path to the saved `best_state.pt` snapshot. Retry export offline by reloading the trainable params via `kartograf_train.model.build_model()` + `torch.load(<out>/best_state.pt)` and calling `kartograf_train.onnx_export.export_model_to_onnx(model, tokenizer, device)` directly — same code path the trainer takes inline, just decoupled from the long full run.

## Environment

- **Hardware:** GTX 960 4GB VRAM + 16GB RAM + i3-2120 (local-first, no cloud).
  Training config (BF16 + LoRA rank 8 + bnb 4-bit base) chosen to fit this
  envelope; see `docs/dev/KARTOGRAF-SPEC.md` §Training paths.
- **CUDA:** 12.2 driver, torch CU118 wheels (forward-compatible).
- **No Python in operator installs** — these scripts only run on the
  operator's training rig. Runtime inference lives in `onnxruntime-node`.

## Invariants (binding)

Per `docs/dev/KARTOGRAF-SPEC.md` + `docs/dev/DEPENDENCY-POLICY.md`:

1. **Vault never in corpus.** Hard denylist on `~/.memphis/vault/**`,
   `.env*`, `**/secrets/**`, `**/.memphis-backup*/**`. Violations count as
   "paths_refused" in the summary.
2. **Secret patterns reject samples.** Same regex set as
   `scripts/secret-scan.sh`: AWS/GCP/GitHub/Anthropic/Slack tokens, JWT,
   PEM private keys, quoted `api_key=` assignments. Matches → sample
   dropped, pattern counted in summary.
3. **Zone taxonomy aligned with chain catalog.** The corpus builder asserts
   that `LIVE_CHAINS` matches keys of `CHAIN_CATALOG` in
   `src/memory/chain-catalog.ts`. Drift → build fails.
4. **Summary proves invariants.** `corpus-v1-summary.json` carries
   `.secret_scan.clean=true` and `.vault_denylist.enforced=true`; Q1 exit
   test asserts both fields.

## Python dependencies — `requirements.txt`

Build-time only. Not an operator runtime dep. Per dep-policy:

- `stdlib` only for N37 (no external Python deps; pure stdlib implementation).
- Q2 additions (`transformers`, `peft`, `bitsandbytes`, `onnx`, `onnxruntime`)
  are all `build-only` class per `docs/dev/DEPENDENCY-POLICY.md`; operators
  do not install them.

## Output layout

After a successful build:

```
~/.memphis/kartograf/corpus/v1/
├── train.jsonl               # stratified 80% of samples by zone
├── eval.jsonl                # stratified 20%
├── zone-labels.json          # ZONE names in canonical order
├── license-audit.json        # per-sample {license, sha256}
└── corpus-v1-summary.json    # build provenance + invariant assertions
```

## Secret-scan alignment

The Python regex set here mirrors `scripts/secret-scan.sh:PATTERN`. When
`secret-scan.sh` is updated (new provider tokens, new false-positive
hardening), `SECRET_PATTERNS` here MUST be updated in the same PR — the
Q1 exit test checks both; drift is a release blocker.
