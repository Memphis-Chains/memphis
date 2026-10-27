# Kartograf readiness inventory — 2026-10-26

At the initial inspection on 2026-10-26, no Kartograf checkpoint, training
corpus or dedicated training venv was installed on the host. Subsequent
isolated preflight environments are described below. The historical May run notes name
`~/.memphis/kartograf/corpus/v4`, `~/.venvs/memphis-train` and an installed
checkpoint; those paths no longer exist. No production training was started,
existing weights were not moved, and no stand-in model was installed.

## Existing implementation and artifacts

The repository contains a real Python training/evaluation/ONNX export pipeline
in `tools/training/`, plus TypeScript signed-envelope, ONNX session and runtime
code. The absence of a Rust `memphis-kartograf` crate does not mean that the
training implementation is missing. Some historical docstrings described only
placeholders and were stale. Smoke/stub modes intentionally remain fixtures;
full-mode export failure now aborts instead of signing a placeholder.

No usable Kartograf ONNX/safetensors/GGUF weights were found in the runtime,
repository model directory, Hugging Face cache or inspected runtime archives.
Two Hugging Face `.no_exist/.../model.safetensors` entries are negative-cache
markers. A broader filename inventory found Basal Llama generative weights
(one safetensors model, two GGUFs), Piper voice ONNX files and Python inference
fixtures. They are different models and are not installed Kartograf checkpoints.

The [v1.7.0 release](https://github.com/Memphis-Chains/memphis/releases/tag/v1.7.0)
contains only `memphis-chains-memphis-1.7.0.tgz` (701,392 bytes), not a model
bundle. Release asset metadata across the repository's available releases showed
no Kartograf/checkpoint/ONNX/safetensors assets. A public Hugging Face model
search for `kartograf` returned no model IDs on this date; private or differently
named artifacts are not ruled out. Local recent backups are about 69 MB each;
this inventory has not restored a model from them.

## Runtime and readiness gaps

The new installer publishes complete hash-verified immutable bundles and requires
explicit trusted-signer activation with an actual inference probe. Status,
queries and the daemon resolve the same selection. Tokenizer hashes are checked
at load as well as install. See [selection runbook](../runbooks/KARTOGRAF-CHECKPOINT-SELECTION.md).
Remote GitHub/HF transports and embedding-cascade integration remain unimplemented.
The [embedding space contract](KARTOGRAF-EMBEDDING-SPACE.md) now binds inference
to verified artifacts and an explicit tokenizer policy, with exact output shape
validation. This prepares a native index boundary; it does not supply that
integration or claim model readiness.

The Q2 gate demands `topZone == "vault"`, but the frozen v1 labels are journal,
decisions, reflections, cases, patterns, system, collective, proactive, insights,
soul and two reserved slots. There is no vault label. Relabeling a reserved slot
on old weights would misrepresent model output. Closing that criterion requires
an agreed new signed model/zone schema and corresponding trained/evaluated
artifact, or an explicitly revised roadmap criterion; it cannot be fixed by
changing a JSON response. The current gate remains failed for model criteria.

The host reports GTX 960, 4096 MiB VRAM. May notes describe a torch 2.3.1 /
transformers 4.43.4 DeBERTa stack, while the current requirements request torch
2.5+ / transformers 4.48+ and the harness checks ModernBERT support. The old venv
is absent. Hardware/library compatibility and the exact pinned model recipe must
be re-established before an actual training run. The producer now supports unsigned artifacts followed by operator-authenticated
`memphis kartograf sign`, using the existing vault-held identity without exporting
the seed. Smoke/full refuse standalone seed files, and the requested pinned
model revision now reaches both model and tokenizer loaders. This closes the
producer key-handling gap; no actual release has been trained or signed.

A subsequent host preflight on 2026-10-27 verified small CUDA forward/backward
operations in FP32 and FP16 on the GTX 960 using an isolated PyTorch 2.14.0
CUDA 12.6 environment. The system's CUDA 13 build lacks Maxwell kernels. This
established a working primitive GPU path. A subsequent full-stack preflight
used Python 3.14, Transformers 5.21.0 and PEFT 0.21.2 with that CUDA build.
A tiny random ModernBERT passed FP16 LoRA backward, the actual contrastive/zone
loss, and the real training loop (gradient accumulation, checkpointing, scaler,
evaluation, best-state restore/save and ONNX export). Five ONNX inputs covered
dynamic lengths and padding. Six Python/Node cases agreed on token IDs and
native embeddings, including Unicode and truncation at 512 tokens.

This uncovered and fixed the removed ModernBERT constructor keyword, the
changed PyTorch exporter default, and JavaScript truncation dropping SEP.
The runtime policy is now `verified-json-content-truncate512-v2`; see the
[embedding-space contract](KARTOGRAF-EMBEDDING-SPACE.md) and
[reproducible preflight](../../tools/training/README.md#python-314--cuda-126-preflight).
No pretrained weights were downloaded. The isolated environment proves the
small architecture/toolchain path; full-size VRAM fit, a curated multi-zone corpus,
convergence and held-out release quality still require verification. Synthetic
evaluation numbers are fixture checks and do not satisfy Q2 model gates.

The next artifact decision needs a real model/tokenizer bundle, producer DID,
pinned source revision and license, evaluation recipe, zone mapping and embedding
index/cascade contract. Independent external security review remains a separate
unmet requirement. Tooling tests and structural activation are not proof of model
quality or Q2 completion.

## Repository corpus baseline — 2026-10-27

A private, repository-only baseline now exists in the operator evidence archive.
It was built from clean tracked sources at
`e095e10630c1990f407b72e8bd38a63b56d00e6f`; operator chains and configuration
were explicitly excluded. It contains 1,560 unique samples, split 1,249/311,
and 1,038 training / 249 evaluation pairs with uniform four hard negatives.
The independent byte audit found zero exact-content split overlap and zero
output secret-pattern matches, and retained content/license provenance hashes.
The scanner conservatively excluded 110 source/example files with pattern hits;
those hits are not a count of live credentials.

The builder and loader now share the frozen v1 label ordering. Runtime chains
`messages` and `autonom_archive` do not rename reserved classifier slots.
Corrupt hashes, changed license provenance, mislabeled/overlapping splits and
malformed or cross-split pairs fail validation before model/tokenizer loading.
See the [reproducible corpus workflow](../../tools/training/README.md#audited-v1-corpus-candidates).

This is a weakly labeled baseline: 1,526 samples are `system`, 30
`reflections`, 4 `decisions`, and the other v1 zones have no examples.
There are 1,040 unambiguous training samples and 251 unambiguous evaluation
samples before pair filtering. Broader coverage, annotation review and
near-duplicate/lineage separation remain necessary for release-quality evaluation.
No release model has been trained or activated from this corpus. The Q2 `vault`
criterion and independent external review remain unmet.
