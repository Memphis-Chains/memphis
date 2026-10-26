# Kartograf readiness inventory — 2026-10-26

The inspected operator host has no installed Kartograf checkpoint directory at
its configured runtime root. No usable ONNX, safetensors or GGUF weights were
found in the runtime, repository model directory or Hugging Face cache searched.
Two Hugging Face `.no_exist/.../model.safetensors` entries are negative-cache
markers, not model weights. The repository's `models/` directory is absent.
No training job was started and no substitute weights were generated.

`nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` reports an
NVIDIA GeForce GTX 960 with 4096 MiB. This inventory does not establish training
capacity or compatibility for a particular architecture; that needs a bounded
probe after selecting the actual checkpoint, tokenizer and training recipe.

The code currently exposes signed local-file checkpoint verification/install,
status, and query. The install handler requires a checkpoint file; a remote
`github-release` fetch for the historical v1.7.0 acceptance command is not
implemented. Status reports installed checkpoints rather than the roadmap's
`active_checkpoint` field. Query needs a verified checkpoint and opt-in ONNX
runtime, and explicitly rejects its stub session. There is no
`crates/memphis-kartograf` training implementation in the inspected checkout.

The real quarterly probe therefore continues to fail checkpoint install, active
checkpoint, semantic vault query and tier-0 cascade acceptance. Passing the
snapshot tests does not change those model-readiness results.

The next concrete deliverable requires the intended real checkpoint artifact
and its provenance (model, tokenizer, signed envelope, weight checksum, license,
training/evaluation recipe). Once available, verify it using the existing file
installer and run bounded ONNX inference plus the vault-zone/cascade checks.
Remote distribution and active-selection semantics can then be implemented
against that reviewed artifact. Inventory results alone do not justify training
or reporting Q2 model readiness.
