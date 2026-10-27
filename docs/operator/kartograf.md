# Kartograf — operator workflow

Use the [checkpoint selection runbook](../runbooks/KARTOGRAF-CHECKPOINT-SELECTION.md)
for the complete current contract. The runtime and corpus inventory is in
[Kartograf readiness](../dev/KARTOGRAF-READINESS-2026-10-26.md).

A bundle contains `checkpoint.json`, `model.onnx` and `tokenizer.json`. Obtain
the expected producer DID independently before activation.

```sh
memphis kartograf verify --file /private/bundle/checkpoint.json --json
memphis kartograf install --file /private/bundle/checkpoint.json --source file --json
memphis kartograf activate CHECKPOINT_ID --trusted-signer did:key:ed25519:EXPECTED_KEY --dry-run --json
memphis kartograf activate CHECKPOINT_ID --trusted-signer did:key:ed25519:EXPECTED_KEY --json
memphis kartograf status --json
memphis kartograf query 'a query' --json
```

`verify` checks the envelope signature. `install` verifies both artifact hashes
and publishes a private immutable version addressed by the canonical envelope
hash. It does not replace an earlier version or automatically select a newly
staged model. An invalid bundle is refused before publication. Use the full
`checkpointId` printed by install with the activation command.

Activation requires a real ONNX load and a finite nonzero embedding of the
expected dimension. A failed probe keeps the prior selection. Dry-run verifies
identity and file integrity without running inference or writing selection.
`install --force-active --trusted-signer DID` combines these operations; dry-run
still creates nothing. Restart the daemon after changing selection so its cached
session reloads. Its existing `MEMPHIS_KARTOGRAF_ENABLE=1` opt-in configuration
remains required; activation does not edit environment configuration.

Status distinguishes the verified `selected_checkpoint` from `active_checkpoint`.
The latter is nonnull only for an enabled runtime with that selection loaded.
JSON query output includes the full embedding, top zone/confidence, model hash
and selected bundle ID. CLI, tools and daemon use the same selection policy.

New bundles live under `kartograf/checkpoints/<full-envelope-hash>/` in the
configured data root. Older 12-hex signer directories retain their historical
fallback when no explicit pointer exists. A corrupt pointer fails closed.
To switch back, activate the previous immutable bundle ID with its trusted DID.
Preserve previous versions and failed private staging for operator inspection;
avoid manually clearing the live model directory.

Training tooling exists under `tools/training/`. Smoke and stub artifacts are
explicit test fixtures. Full-mode export failure aborts and retains trained state
for a later export retry; it cannot silently become a signed placeholder release.
Actual training requires the real corpus, compatible ML environment, pinned
model/zone recipe and signing through the host's vault policy. This update does
not create those missing resources or change model evaluation results.

GitHub/HF transport and embedding-cascade integration remain unfinished. The Q2
`vault`-zone criterion also requires an agreed model/label schema: the frozen v1
labels do not include a vault class. Tooling and integrity tests do not establish
semantic quality or independent external security review.
