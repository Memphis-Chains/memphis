# chain export — production semantics

## Command

```bash
memphis chain export --chain <name> [--out <file>]
```

Single-chain export is implemented for `v1.0.0`.

`--all` export is intentionally out of scope for `v1.0.0` to avoid introducing
an archive contract during RC closure.

## Behavior

Export is read-only:

- reads block files from `~/.memphis/chains/<chain>/NNNNNN.json`
- validates block order and hash integrity before serializing
- writes the export envelope to stdout by default
- writes the export envelope to `--out` when provided

If `--out` is omitted, stdout receives the full export envelope JSON.

If `--out` is provided:

- the JSON envelope is written to the target file,
- human mode prints a short summary,
- `--json` prints metadata only (`chain`, `blockCount`, `exportedAt`, `out`).

## Export schema

The output mirrors the single-chain import envelope:

```json
{
  "chainName": "journal",
  "exportedAt": "2026-03-26T12:00:00.000Z",
  "blockCount": 42,
  "blocks": [
    {
      "index": 1,
      "timestamp": "2026-03-20T10:00:00.000Z",
      "chain": "journal",
      "data": {
        "type": "journal",
        "content": "example",
        "tags": ["memory"]
      },
      "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
      "hash": "sha256-of-block"
    }
  ]
}
```

The `blocks` array is intentionally the same shape that `chain import_json`
already accepts through its `blocks` envelope path.

## Examples

```bash
# Export a chain to stdout
memphis chain export --chain journal

# Export to a specific file
memphis chain export --chain journal --out journal-export.json

# Export metadata summary in JSON while writing to file
memphis chain export --chain journal --out journal-export.json --json
```

## Round-trip compatibility

The intended operator flow is:

```bash
memphis chain export --chain journal --out journal-export.json
memphis chain import_json --file journal-export.json --json
```

Round-tripping preserves block order and the canonical block payload required by
the importer.

## Errors

The command fails when:

- `--chain` is missing,
- the named chain directory does not exist,
- a block file is malformed,
- block hashes or `prev_hash` links fail validation.

## Relationship to import

See `docs/CHAIN-IMPORT-JSON.md` for accepted import input shapes and write-mode
semantics.
