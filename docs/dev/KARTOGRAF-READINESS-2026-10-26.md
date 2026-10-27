# Kartograf readiness inventory — 2026-10-26

No Kartograf checkpoint, training corpus or dedicated training venv is installed
on the inspected host. The historical May run notes name
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

The next artifact decision needs a real model/tokenizer bundle, producer DID,
pinned source revision and license, evaluation recipe, zone mapping and embedding
index/cascade contract. Independent external security review remains a separate
unmet requirement. Tooling tests and structural activation are not proof of model
quality or Q2 completion.
