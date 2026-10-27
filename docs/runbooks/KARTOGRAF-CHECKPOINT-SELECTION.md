# Kartograf checkpoint installation and selection

A checkpoint is a signed `checkpoint.json` envelope and the sibling
`model.onnx` and `tokenizer.json`. Local file/federation transport verifies the
signature and both complete artifact hashes before publishing anything. An
invalid replacement is refused and leaves previous bundles and selection intact.

```sh
memphis kartograf install --file /private/bundle/checkpoint.json --source file --json
# Use checkpointId from the successful install and a producer DID obtained independently.
memphis kartograf activate CHECKPOINT_ID --trusted-signer did:key:ed25519:EXPECTED_KEY --dry-run --json
memphis kartograf activate CHECKPOINT_ID --trusted-signer did:key:ed25519:EXPECTED_KEY --json
memphis kartograf status --json
memphis kartograf query 'a query' --json
```

Install publishes to `kartograf/checkpoints/<sha256-of-canonical-envelope>/` in
the configured runtime data directory. Each version has a separate directory;
reinstalling an identical bundle is idempotent. Existing installed versions are
not deleted. Failed private `.install-*` staging directories may remain for
inspection and never appear in the selection catalog. The store parent must be
operator-controlled; symlink destinations and artifacts are refused. Artifacts
are limited to 2 GiB for the model, 64 MiB for the tokenizer, and 1 MiB for the
envelope. Published artifact files are 0600 and new directories are 0700.

Activation acknowledges the expected producer DID, loads an actual ONNX session,
and checks a finite nonzero embedding with the declared dimension. Stub sessions,
load failures, changed hashes or invalid inference do not change `active.json`.
The pointer binds the complete envelope ID and signer and is written atomically
with mode 0600. `--force-active --trusted-signer DID` on install performs the same
activation validation. An activation dry-run validates identity and file integrity
without loading the model or changing selection; it does not prove inference.

New installs remain staged until activated. With no pointer, old 12-hex legacy
install directories retain their historical fallback behavior. An invalid,
missing-target or symlinked pointer fails closed; the runtime does not silently
choose another model. Old legacy bundles remain readable and rollback APIs for
legacy directories are retained. Keep a previous immutable bundle to switch back
by explicitly activating its ID; do not edit or remove a live model directory.

The runtime feature remains opt-in through its existing configuration flag.
Activation probes inference but does not rewrite `.env` or turn on that flag.
Restart the daemon after changing selection so its cached session reloads.
`selected_checkpoint` describes the verified selection; `active_checkpoint` is
nonnull only when the enabled runtime actually loaded that selection. JSON query
output includes the full embedding, top zone/confidence and selected bundle ID;
`checkpointId` remains the model hash for existing consumers.

These checks establish artifact integrity and structural inference, not training
quality. Semantic zone accuracy and retrieval quality still need evaluation on
real data. No model is manufactured by this installer, and this feature does not
make the Q2 model or independent-audit criteria pass.
