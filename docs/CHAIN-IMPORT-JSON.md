# chain import_json — production semantics

## Command

```bash
memphis-v4 chain import_json --file <path> [--json]
```

## Accepted input schemas

Importer accepts all of:

1. **Direct array**
   - `[{...}, {...}]`
2. **Object with blocks**
   - `{ "blocks": [{...}] }`
3. **Legacy object with chain**
   - `{ "chain": [{...}] }`

Per-block key mapping supports:

- index: `index | idx | height`
- prev hash: `prev_hash | prevHash | previous_hash | previousHash`
- hash: `hash | block_hash`
- timestamp: `timestamp | ts | created_at`
- chain name: `chain | chain_name`
- content: `content | data.content | data.text`
- tags: `tags | data.tags`
- type: `type | block_type | data.type | data.block_type`

## Reconciliation rules

Importer produces a normalized canonical chain:

- **Index consistency**: output index is rewritten to dense sequential `0..N-1`
- **Link consistency**:
  - genesis `prev_hash` is forced to `64x0`
  - every next block `prev_hash` is forced to previous block `hash`
- **History/index/link consistency** therefore always converges to a valid linear sequence

Migration report includes rewrite counters:

- `reconciliation.indexRewritten`
- `reconciliation.prevHashRewritten`

## Idempotency and duplicates

Policy is explicit in output:

- `idempotentKey: "hash"`
- `duplicateHandling: "skip-by-hash"`

If the same payload (or overlapping payload with same hashes) is imported repeatedly,
duplicates are skipped deterministically.

## Migration report

JSON mode (`--json`) returns:

- source shape and total candidates
- imported/skipped counts
- reconciliation counters
- issue list with reasons
- normalized `blocks` payload

Text mode prints a human migration summary with key counts and issues.

## Rollback strategy (operator)

`import_json` is currently **non-destructive** and does not mutate persistent chain storage.
Rollback is therefore straightforward:

1. Keep source file under version control / backup.
2. If report quality is not acceptable (`valid=false` or unexpected rewrites), stop pipeline.
3. Fix source payload and rerun import.
4. For automated pipelines: gate on expected thresholds (e.g. max rewritten/skipped).

Future write-enabled mode should remain rollback-safe via:

- pre-import snapshot of destination
- transactional write
- post-import checksum verification
- one-command restore from snapshot
