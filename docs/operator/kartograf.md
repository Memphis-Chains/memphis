# Kartograf — operator runbook

Sprint K (Q1 N32) — operator surface for Kartograf checkpoint distribution.

## What ships today (Q1)

- `memphis kartograf verify --file <envelope.json>` — verify a signed checkpoint envelope (operator-trusted source) without installing
- `memphis kartograf install --file <envelope.json> --source file` — verify + stage to `~/.memphis/kartograf/checkpoints/<signer-slug>/`
- `memphis kartograf status` — list installed checkpoints + integrity status
- `memphis kartograf query` — reserved for Y2 (returns structured "not yet" with the path forward)
- Doctor `ta13-kartograf` check — visibility on installed checkpoint count + signers

## What lands Q2

- Kartograf training pipeline (`tools/training/train-kartograf.py`) — produces ONNX checkpoints
- ONNX runtime loader — feeds embeddings + zone classification back into Memphis
- `memphis kartograf query --query <text>` — pulls embedding + zone from the installed checkpoint
- HF hub + GitHub release transports for `--source` (today only `file` and `federation` work locally)

## Concepts

A Kartograf **checkpoint** is a signed envelope plus two artifacts:

- `checkpoint.json` — the signed envelope (signer DID, hashes, version, distribution_source)
- `model.onnx` — the trained model weights
- `tokenizer.json` — the tokenizer config

The envelope's signature is verified against the producer's DID before install. The hashes inside the envelope (`onnx_sha256`, `tokenizer_sha256`) are checked against the actual artifact bytes during install — a mismatch refuses the file copy.

Once installed, checkpoints live under:

```
~/.memphis/kartograf/checkpoints/
  <signer-slug>/
    checkpoint.json
    model.onnx
    tokenizer.json
```

`<signer-slug>` is the last 12 hex chars of the signer DID.

## Install workflow (Q1, local file)

```bash
# 1. Producer hands you an envelope + sibling artifacts (e.g. via /tmp or USB)
ls /tmp/kartograf-bundle/
# checkpoint.json  model.onnx  tokenizer.json

# 2. Verify the envelope signature without touching disk
memphis kartograf verify --file /tmp/kartograf-bundle/checkpoint.json --json

# 3. If verify is OK, install (verify + copy artifacts to staging dir)
memphis kartograf install --file /tmp/kartograf-bundle/checkpoint.json --source file --json

# 4. Confirm
memphis kartograf status --json
memphis doctor 2>&1 | grep ta13-kartograf
```

## Common errors

| Symptom | Diagnosis | Fix |
|---|---|---|
| `verify` returns `ok: false reason: signature mismatch` | Envelope was tampered or signed by a key the runtime doesn't trust | Get the envelope from the producer again over a trusted channel; do NOT install |
| `install` succeeds but `model.onnx: sha256 mismatch — artifact not copied` | Bundle is misassembled (envelope hash doesn't match the binary) | Re-fetch from the producer; the envelope and binary must come together |
| `ta13-kartograf` warns `staging dir exists but no checkpoints found` | `~/.memphis/kartograf/checkpoints/` exists (probably from prior init) but every subdir is empty | Run `memphis kartograf install` once you have a real envelope |
| `query` returns `ok: false reason: Kartograf inference is Y2 scope` | Working as designed for Q1 | Use `verify` + `install` + `status` until inference pipeline ships |

## Dry-run install

Pass `--dry-run` to see what `install` would do without touching the filesystem:

```bash
memphis kartograf install --file /tmp/bundle/checkpoint.json --source file --dry-run --json
# returns mode: 'kartograf.install.dry-run' with the planned stageDir + envelopeOut paths
```

## Switching back / removing a checkpoint

There's no `memphis kartograf uninstall` today. To remove an installed checkpoint:

```bash
rm -rf ~/.memphis/kartograf/checkpoints/<signer-slug>/
memphis kartograf status   # confirm it's gone
```

When a producer publishes a new checkpoint signed with the same DID, the install flow clears the old `model.onnx` + `tokenizer.json` from the stage dir before staging the new ones (no mixed-state hazard).

## Related

- `docs/dev/KARTOGRAF-SPEC.md` — model spec + training pipeline (Y2)
- `src/kartograf/checkpoint.ts` — verify + envelope primitives
- `src/infra/cli/handlers/kartograf.handler.ts` — CLI handler
