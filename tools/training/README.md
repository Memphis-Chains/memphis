# tools/training

Build-time tooling for Kartograf + future WatraLLM checkpoints. Scripts here
run **outside the Memphis operator runtime** — they are developer utilities
for generating corpora, running training, exporting ONNX.

Operator installs do NOT need Python. These scripts are only invoked when
producing a new Kartograf checkpoint for release.

## Contents

| Script                        | Scope                                                                                                                                                                                                                                                                     | Status       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `kartograf-corpus.py`         | Y1 Q1 N37 — walk repo + chains, scan for secrets, label zones, write train/eval JSONL                                                                                                                                                                                     | v1 shipped   |
| `kartograf-pair-miner.py`     | Y1 Q2 N32 Phase 1 — retrofit corpus with contrastive pairs (git co-occurrence + symbol TF-IDF + cross-zone hard negatives)                                                                                                                                                | Q2 Phase 1   |
| `kartograf-corpus-augment.py` | Y1 Q2 N32 Phase 2.5 — extend v1 corpus with external reference material (Rust Book + TS Handbook + memphis-v5.pl/docs) → corpus v2                                                                                                                                        | Q2 Phase 2.5 |
| `train-kartograf.py`          | Y1 Q2 N32 Phase 2-4 — load corpus+pairs, LoRA fine-tune ModernBERT + two heads, eval rig, ONNX export, sign envelope. `--mode stub` = N37.2 behavior; `--mode smoke` = 50-step proof-of-life; `--mode full` = real run with end-of-epoch eval + best-checkpoint tracking. | Q2 Phase 2-4 |
| `kartograf_train/` package    | Y1 Q2 N32 — data loader + model + loss + training loop + eval rig + ONNX export (invoked by `train-kartograf.py`)                                                                                                                                                         | Q2 Phase 2-4 |
| `MODELCARD-TEMPLATE.md`       | Template for per-release MODELCARD.md (fill in `{{...}}` slots from checkpoint envelope + eval results)                                                                                                                                                                   | Q2 Phase 4   |

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

Training and release signing are separate. Run the trainer in a fresh,
operator-controlled output directory outside the runtime checkpoint store.
A synthetic stub needs no model download or signing key:

```bash
python3 tools/training/train-kartograf.py --mode stub \
  --corpus /private/corpus --out /private/karto-stub --unsigned
```

Smoke/full require an actual 40-hex Hugging Face commit obtained from the
chosen model's repository. Supply the same source to both modes:

```bash
python3 tools/training/train-kartograf.py --mode full \
  --corpus /private/corpus --out /private/karto-full --unsigned \
  --base-model owner/model@REPLACE_WITH_REAL_40_HEX_COMMIT
```

The selected model and tokenizer are loaded from that same commit. Do not
infer GPU compatibility from this example: the host's actual CUDA, torch,
transformers and architecture combination still requires preflight.

The trainer writes `model.onnx`, `tokenizer.json` and
`unsigned-checkpoint.json`. This metadata is deliberately not installable.
Full-mode export failure aborts and retains `best_state.pt` for investigation;
it never publishes a placeholder as a release. Stub/smoke use fixture ONNX
bytes and cannot pass the release signer. Existing output artifacts cause an
error; select a fresh directory rather than replacing an earlier candidate.
`--signing-seed-file` is retained only for synthetic stub fixtures. It is
refused for smoke/full before any key file or model is read.

After reviewing the artifacts, measured evaluation and provenance, sign on
the operator host with its existing vault-held `did_seed` identity:

```bash
memphis kartograf sign --file /private/karto-full/unsigned-checkpoint.json --json
memphis kartograf verify --file /private/karto-full/checkpoint.json --json
```

The sign command requires operator authentication, verifies metadata and
both complete artifact hashes, rejects known placeholders, and creates a
0600 signed envelope without overwriting an existing one. Key material stays
inside the vault callback; Python receives no private key. It does not install
or activate the model. Follow the [selection runbook](../../docs/runbooks/KARTOGRAF-CHECKPOINT-SELECTION.md)
for explicit trusted-signer installation and activation. A signature proves
integrity and attribution, not model accuracy or GPU suitability.

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
