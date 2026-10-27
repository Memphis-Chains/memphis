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

## Python 3.14 / CUDA 12.6 preflight

`requirements.txt` remains the older training profile. On the operator's
GTX 960 (Maxwell 5.2), use an isolated environment with the explicit
`requirements-cu126-preflight.txt` profile. Install PyTorch from its official
CUDA 12.6 index first; the second command preserves that exact CUDA build:

```bash
python3.14 -m venv /private/kartograf-preflight-venv
/private/kartograf-preflight-venv/bin/python -m pip install \
  --index-url https://download.pytorch.org/whl/cu126 'torch==2.14.0+cu126'
/private/kartograf-preflight-venv/bin/python -m pip install \
  --index-url https://pypi.org/simple --only-binary=:all: \
  -r tools/training/requirements-cu126-preflight.txt
/private/kartograf-preflight-venv/bin/python -m pip check
```

Use disk-backed `TMPDIR` if the host's `/tmp` is a small tmpfs. The profile
pins direct dependencies; retain `pip freeze` and the install report with
run evidence to record transitive versions. It excludes bitsandbytes because
this preflight exercises FP16 LoRA, not NF4 quantization. See the official
[PyTorch CUDA support matrix](https://github.com/pytorch/pytorch/blob/main/RELEASE.md#pytorch-cuda-support-matrix).

Obtain only `config.json`, `tokenizer.json`, and `tokenizer_config.json`
from one pinned ModernBERT commit. The tested public source was
[`answerdotai/ModernBERT-base@8949b909ec900327062f0ebf497f51aef5e6f0c8`](https://huggingface.co/answerdotai/ModernBERT-base/tree/8949b909ec900327062f0ebf497f51aef5e6f0c8),
Apache-2.0. No pretrained weights are needed for this test. Keep the original
file hashes with the evidence. Run against a fresh output directory:

```bash
/private/kartograf-preflight-venv/bin/python tools/training/preflight-modernbert.py \
  --tokenizer-dir /private/pinned-tokenizer --out /private/new-preflight-run
node --import tsx tools/training/check-preflight-runtime.ts \
  /private/new-preflight-run /private/pinned-tokenizer
```

The offline Python probe creates a seeded, tiny random ModernBERT, loads it
through the real model builder, performs one GPU LoRA/heads optimization
step with the real contrastive/zone loss, exports ONNX and tests several
sequence lengths plus a padded batch. The Node probe compares Python token
IDs, embeddings and zone probabilities against the actual runtime. It uses
an ephemeral synthetic signing identity inside the fixture directory and
never installs or activates an operator checkpoint. Both scripts fail on
mismatch; rerun with a fresh output directory.

Measured on 2026-10-27: Python 3.14, torch 2.14.0+cu126, Transformers
5.21.0, PEFT 0.21.2; FP16 GPU backward and all five ONNX parity inputs
passed. Python/Node parity passed six cases, including Unicode and a
512-token input. This proves the small architecture/toolchain path, not
full-size VRAM fit, convergence, retrieval quality, or Q2 release readiness.

Export explicitly uses the legacy tracer with dynamic axes and a single
ONNX file. [PyTorch's ONNX API](https://docs.pytorch.org/docs/stable/onnx.html)
now defaults to the dynamo exporter; relying on that default changed the
producer's dependencies and artifact behavior. Parity rejects non-finite
outputs, zero embeddings, shape mismatches and any individual divergent row.
Full training continues to abort on export failure, preserving trained state.

## Audited v1 corpus candidates

Use a clean Git checkout and a fresh private output directory. The builder
reads tracked allowlisted source files, rejects symlinks/protected paths and
secret-pattern matches, records the source commit and builder/contract hashes,
then deduplicates content before a seeded stratified split. Conflicting labels
for identical content are excluded; private aliases never gain a public license.
The default split seed is 42. Populated zones with at least six unique samples
retain at least two evaluation items for non-self retrieval pairs.

For a repository-only baseline, explicitly disable operator data inputs:

```bash
python3 tools/training/kartograf-corpus.py \
  --repo-root /path/to/clean/memphis --chains-dir '' --data-root '' \
  --out-dir /private/new-corpus --split-seed 42 --no-teacher
python3 tools/training/kartograf-pair-miner.py \
  --corpus /private/new-corpus --repo-root /path/to/clean/memphis --source train
python3 tools/training/kartograf-pair-miner.py \
  --corpus /private/new-corpus --repo-root /path/to/clean/memphis --source eval
python3 tools/training/audit-kartograf-corpus.py --corpus /private/new-corpus \
  --require-pairs --require-eval --report /private/new-corpus-audit.json
```

Existing corpus/pair/report outputs are preserved: rerun into a fresh candidate.
Pair mining excludes ambiguous labels and emits the requested uniform number
of cross-zone hard negatives. Each pair stays inside its own split. The audit
rehashes/re-scans actual content, checks license provenance, duplicate/overlap
constraints and pairs, and retains a hash manifest. Summary booleans alone do
not establish validity. The training loader applies the same boundary before
loading a tokenizer/model. Legacy augmented/merged corpora must satisfy these
checks; inherited `clean` flags do not exempt newly added content.

The builder, pair miner and trainer use the frozen runtime v1 ordering, including
both reserved slots. The newer `messages` and `autonom_archive` chains are not
v1 classifier labels and are excluded rather than assigned to reserved indices.
A new schema with `vault` still requires separately versioned, trained and
evaluated artifacts; this corpus work does not change Q2 classification gates.

The initial repository baseline built on 2026-10-27 from commit
`e095e10630c1990f407b72e8bd38a63b56d00e6f` contains 1,560 unique samples
(1,249 train / 311 eval). The scanner excluded 110 files with pattern matches;
this includes conservative matches in credential fixtures and source examples,
not evidence of 110 live credentials. The output has zero detected secret-pattern
hits and zero exact-content train/eval overlap. It includes no operator chains
or configuration. Labels are path heuristics, not reviewed semantic annotations.
Of the samples, 1,526 are `system`, 30 `reflections`, and 4 `decisions`.
This imbalance and absent zones require curation before a release-quality run.
Exact-content deduplication does not establish independence from near duplicates.

The real loader accepted 1,038 training anchors and 249 evaluation pairs.
A two-step FP16 GPU smoke run on this corpus with a tiny random ModernBERT
passed; malformed labels were rejected before either model/tokenizer loader
was called. This exercises data plumbing only. Smoke output remains an explicit
placeholder and is not a deployable or evaluated release checkpoint.
