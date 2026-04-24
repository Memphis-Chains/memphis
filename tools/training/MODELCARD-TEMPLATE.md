# Kartograf v1.7.0 — Model Card (template)

> Fill in fields marked `{{...}}` from the matching training run's
> `checkpoint.json` and `eval-results.json` before publishing to HF Hub
> or attaching to a GH release. This file is committed as a template;
> the released MODELCARD.md is generated per release tag.

## Identity

- **Name:** Kartograf
- **Version:** {{envelope.version}} (e.g. `kartograf-v1`)
- **Release tag:** {{git.tag}} (e.g. `v1.7.0-rc0`)
- **Base model:** {{envelope.base_model}} (`answerdotai/ModernBERT-base@{{git.commit}}`)
- **Parameters:** ~150M base + {{model.trainable_params}} trainable (LoRA rank 8 + two heads)
- **License:** Apache-2.0 (this checkpoint). Base model Apache-2.0. See Corpus attribution below.

## Role

Kartograf is Memphis's **tier-0 embedding + zone classifier**. Purpose:

1. Produce 256-dim L2-normalized embeddings for chain retrieval.
2. Emit 12-class zone logits so agent queries route to the correct
   Memphis chain / reference material.

It is **not** a code generator. Runtime agents consult Kartograf's
output to decide WHERE to look; generation happens in a separate LLM
(Ollama-hosted on operator hardware).

## Architecture

- Encoder: `answerdotai/ModernBERT-base` (22 layers, 768 hidden).
- Head 1: `Linear(768, 256)` + L2-norm. Trained via InfoNCE on pairs from `pairs.jsonl`.
- Head 2: `Linear(768, 12)` + softmax-at-inference. Trained via class-weighted cross-entropy.
- LoRA adapters (r=8, α=16) on `Wqkv` + `Wo` of every attention block; base weights frozen.
- Multi-task loss: `L = λ₁·InfoNCE + λ₂·CE` with λ₁=1.0, λ₂=0.5 (spec defaults).

## Training

- **Corpus version:** {{envelope.training_provenance.corpus_version}} (v2 = v1 + rust-book + ts-handbook + memphis-v5 docs)
- **Training path:** {{envelope.training_provenance.hardware}} (Path A — GTX 960 local, FP16 or BF16 depending on compute capability)
- **Epochs:** {{config.epochs}}
- **Total optimizer steps:** {{envelope.training_provenance.steps}}
- **Best recall@10:** {{eval.retrieval_recall_at_10}}
- **Best zone accuracy:** {{eval.zone_accuracy}}
- **ECE:** {{eval.ece}}
- **Wall clock:** {{training.wall_clock}}

## Corpus composition (v2)

Totals: {{corpus.train_count}} train / {{corpus.eval_count}} eval / {{corpus.source_count}} source.

| Source | Samples | License | Url |
|---|---|---|---|
| Memphis repo (src + docs + tests + crates) | {{corpus.memphis_repo}} | Apache-2.0 | github.com/Memphis-Chains/memphis |
| Memphis chain blocks (operator runtime history) | {{corpus.memphis_chains}} | operator:local-only | not redistributed |
| The Rust Programming Language | 905 | Apache-2.0 | github.com/rust-lang/book |
| TypeScript Handbook | 1440 | CC-BY-4.0 | github.com/microsoft/TypeScript-Website |
| memphis-v5.pl/docs | 36 | operator:public | memphis-v5.pl/docs |

**Attribution:**
- The Rust Programming Language © Steve Klabnik, Carol Nichols, and the Rust Project contributors. Apache-2.0.
- TypeScript Handbook © Microsoft Corporation. CC-BY-4.0.
- memphis-v5.pl documentation © Memphis-Chains.

## Zone distribution (v2 split)

{{zone_distribution_table}}

## Evaluation

Held-out eval set: {{eval.eval_size}} samples.

| Metric | Target (spec §Eval protocol) | Actual |
|---|---|---|
| retrieval_recall_at_10 | ≥ 0.75 | {{eval.retrieval_recall_at_10}} |
| zone_accuracy | ≥ 0.90 | {{eval.zone_accuracy}} |
| ece | < 0.05 | {{eval.ece}} |
| latency p99 | < 200ms on GTX 960 FP16 | {{eval.latency_p99_ms}}ms |

**Pass / fail:** {{eval.pass_or_fail}}

Per-class F1:
{{per_class_f1_table}}

## Intended use

- **Tier-0 embedding retrieval** for Memphis chain search (replaces `nomic-embed-text` as first-try provider).
- **Agent navigation** — query "I need to do X" → top-K retrieved chunks guide which Memphis area / reference page to consult next.
- **Zone routing** — classify incoming memory blocks into the correct chain before write.

## Out of scope / limitations

- **Not a code generator.** Does not write code. Use retrieved chunks to inform a separate generation LLM.
- **Not an authoritative safety gate.** Advisory only. Hard safety blocks remain path-based in `src/mcp/tools/self-modify.ts`.
- **Not a tool invoker.** Classifier output only; no action-taking.
- **150M params.** Limited world knowledge; no CoT reasoning; no long-range document synthesis.
- **Polish-language coverage thin.** 36 chunks from memphis-v5.pl are the only Polish signal in ~3800-sample corpus. Queries in Polish may retrieve mostly English results.

## Security

- Trained on a corpus with enforced secret-scan invariant (`corpus-v1-summary.json.secret_scan.clean = true`).
- Vault-denylist enforced (`corpus-v1-summary.json.vault_denylist.enforced = true`).
- Checkpoint envelope Ed25519-signed; verify with `memphis kartograf verify --file checkpoint.json` before any install.

## Known divergences from spec v1

- **INT8 quantized variant not shipped** in this release. FP16 ONNX only. INT8 is Phase 4b.
- **Corpus v2** (this release) extends spec's v1 allowlist with rust-book + ts-handbook + memphis-v5 docs. Additive — existing v1 allowlist still satisfied.

## Reproducibility

```bash
# Reconstruct the corpus:
python3 tools/training/kartograf-corpus.py
python3 tools/training/kartograf-corpus-augment.py \
  --v1-dir ~/.memphis/kartograf/corpus/v1 \
  --v2-dir ~/.memphis/kartograf/corpus/v2 \
  --rust-book-dir /path/to/rust-lang/book/src \
  --ts-handbook-dir /path/to/ts-website/packages/documentation/copy/en \
  --memphis-v5-dir /path/to/memphis-v5-pages

# Pair miner on v2:
python3 tools/training/kartograf-pair-miner.py --corpus ~/.memphis/kartograf/corpus/v2

# Train:
python3 tools/training/train-kartograf.py \
  --mode full \
  --corpus ~/.memphis/kartograf/corpus/v2 \
  --out ~/.memphis/kartograf/checkpoints/run-$(date +%s) \
  --signing-seed-file /path/to/operator.seed
```

## References

- Spec: `docs/dev/KARTOGRAF-SPEC.md`
- Roadmap: `docs/roadmap/Y1-2026-05-to-2027-05.md`
- Research brief: `notes/kartograf-v2-research.md`
- Y1 Q2 N32 plan: `.claude/plans/drifting-squishing-wadler.md`
