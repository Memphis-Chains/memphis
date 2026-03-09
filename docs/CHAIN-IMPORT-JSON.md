# chain import_json — production semantics

## Command

```bash
memphis-v4 chain import_json --file <path> [--json] [--out <target>] [--write --confirm-write]
```

Default mode is **dry-run** (no mutation). Write mode is opt-in and requires both:

- `--write`
- `--confirm-write`

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

Migration report includes rewrite counters:

- `reconciliation.indexRewritten`
- `reconciliation.prevHashRewritten`

## Idempotency and duplicates

Policy is explicit in output:

- `idempotentKey: "hash"`
- `duplicateHandling: "skip-by-hash"`

If the same payload (or overlapping payload with same hashes) is imported repeatedly,
duplicates are skipped deterministically.

## Write mode (transactional)

When write mode is enabled, importer writes normalized blocks to target file (default: `./data/imported-chain.json`) using transactional flow:

1. serialize to `target.tmp`
2. create `target.bak` if target already exists
3. atomic rename `target.tmp -> target`

Additional protection:

- source path and destination path must be different (prevents accidental self-overwrite)

## Migration report

JSON mode (`--json`) returns:

- source shape and total candidates
- imported/skipped counts
- reconciliation counters
- issue list with reasons
- normalized `blocks` payload
- `write` section (`mode`, `targetPath`, optional `backupPath`)

Text mode prints a human migration summary with key counts, mode, and issues.

## Rollback strategy (operator)

### H3.2 rollback

If write mode created/updated a target file:

```bash
cp <target>.bak <target>
```

If no backup exists (first write), remove the written target and rerun dry-run:

```bash
rm -f <target>
memphis-v4 chain import_json --file <input> --json
```

Recommended operator flow:

1. run dry-run first
2. verify report/rewrites
3. run write mode only with explicit confirmation
