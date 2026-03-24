# Chain Export

**Date:** 2026-03-24
**Status:** PLANNED — not yet implemented

---

## Current State

Chain **import** is fully implemented and documented in `docs/CHAIN-IMPORT-JSON.md`. Chain **export does not exist yet** — there is no `memphis chain export` CLI command.

Current chain CLI subcommands:
- `memphis chain import_json --chain <name> [--out <file>]`
- `memphis chain verify`
- `memphis chain rebuild`

---

## Planned Behavior

When implemented, chain export should:

1. **Read** chain blocks from `~/.memphis/chains/<chain>/NNNNNN.json`
2. **Serialize** to the same JSON schema as import (see below)
3. **Output** to a file or stdout

### Export Format

The export format mirrors the import format defined in `docs/CHAIN-IMPORT-JSON.md`:

```json
{
  "chainName": "journal",
  "exportedAt": "2026-03-24T12:00:00.000Z",
  "blockCount": 42,
  "blocks": [
    {
      "index": 0,
      "timestamp": "2026-03-20T10:00:00.000Z",
      "chain": "journal",
      "data": { ... },
      "hash": "sha256-of-block",
      "signature": "base64-signature"
    }
  ]
}
```

### Planned CLI Syntax

```bash
# Export a chain to stdout
memphis chain export --chain journal

# Export to a specific file
memphis chain export --chain journal --out journal-backup-2026-03-24.json

# Export all chains
memphis chain export --all --out all-chains-2026-03-24.tar.gz
```

---

## Design Notes

### Export Path

```
~/.memphis/chains/<chain>/NNNNNN.json  (source of truth)
              │
              ▼
    Read all block files in order
              │
              ▼
    Construct export JSON envelope
              │
              ▼
    Write to --out path or stdout
```

### Integrity

- Export should verify block hashes before serializing
- A `--verify` flag should run `chain_verify` on the exported data before writing
- Export is a **read-only** operation — does not modify chain files

### Relationship to Import

`docs/CHAIN-IMPORT-JSON.md` documents:
- Dry-run mode
- Key alias normalization
- Transactional writes (atomic rename)
- Rollback from `.bak`

Export should use the **same JSON schema** as import to ensure round-trip compatibility. An exported-and-reimported chain should produce identical blocks.

---

## Implementation References

- `docs/CHAIN-IMPORT-JSON.md` — import format and implementation
- `src/infra/storage/chain-adapter.ts` — chain read operations (no export fn yet)
- `src/infra/cli/handlers/storage.handler.ts` — CLI dispatcher (only `import_json`, `verify`, `rebuild`)

---

## TODO

- [ ] Implement `chain_export` CLI command in `storage.handler.ts`
- [ ] Add `exportChain()` function to `chain-adapter.ts`
- [ ] Add unit tests for export round-trip (export → import → compare blocks)
- [ ] Document export in this file (remove "PLANNED" status)
