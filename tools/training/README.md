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
| `kartograf-train.py` | Y1 Q2 N32 — load corpus, LoRA fine-tune ModernBERT + heads, save checkpoint | pending Q2 |
| `kartograf-eval.py` | Y1 Q2 N32 — 500-query held-out eval | pending Q2 |
| `kartograf-export-onnx.py` | Y1 Q2 N32 — merge LoRA, export ONNX FP16 + INT8 variants | pending Q2 |

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
