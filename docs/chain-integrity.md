# Chain integrity, GC, and snapshots

Sprint 12 closes three durability gaps in the chain storage layer:

1. **Verification** — `memphis chain verify` (TS-side) now has a tampering
   test that proves a single byte flip is detected.
2. **Archive GC** — `archiveGC()` prunes old gzipped archives down to a
   keep-count, opt-in via `MEMPHIS_CHAIN_GC_ENABLED` so the operator
   explicitly authorises permanent deletion.
3. **Snapshot on rotation** — `takeChainSnapshot()` writes a
   `snapshot-<ts>.json` to `data/chain-snapshots/` before each rotation,
   capturing chain head + last 1000 blocks. Existing `pruneSnapshots()`
   ages them out.

## Verification

`verifyChainIntegrity(chainName?)` (`src/infra/storage/chain-adapter.ts`)
re-reads every block file in the active chain, recomputes its hash via
the same canonical-JSON SHA-256 algorithm used by the Rust core, and
verifies the parent link from genesis. A tampered block surfaces as
`Error: chain integrity check failed for <file>: hash mismatch`.

Run from the CLI:

```
memphis chain verify [--chain <name>]
```

## Archive GC

```ts
archiveGC(chainName, { gcEnabled, gcKeep })
```

| Flag/Env | Default | Meaning |
|---|---|---|
| `MEMPHIS_CHAIN_GC_ENABLED` | `false` | When `true`, GC runs after each rotation. |
| `MEMPHIS_CHAIN_GC_KEEP_ARCHIVES` | `8` | Number of most-recent archives to retain. |

GC sorts archives by the embedded ISO timestamp in the archive filename
(`{chain}_{first}-{last}_{ISO}.jsonl.gz`), falling back to file mtime
when the format ever changes. Older archives beyond the keep window are
deleted. Best-effort: a missing or locked file is silently skipped — the
deleted-count is the source of truth.

GC is **off by default**. Data deletion is irreversible; the operator
must opt in explicitly. The `archiveGC()` return value reports
`archivesScanned`, `archivesDeleted`, `bytesFreed`, plus the kept and
deleted file lists for audit.

## Snapshot on rotation

```ts
takeChainSnapshot(chainName, { snapshotTailBlocks, snapshotDir })
```

| Flag/Env | Default | Meaning |
|---|---|---|
| `MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION` | `true` | When `true`, every `rotateChain()` writes a snapshot before archiving. |
| `MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS` | `1000` | Trailing block count captured in each snapshot. |
| `MEMPHIS_SNAPSHOT_MAX_AGE_MS` (existing) | 7 days | Hand-off to `pruneSnapshots()`. |
| `MEMPHIS_SNAPSHOT_MIN_KEEP` (existing) | 3 | Hand-off to `pruneSnapshots()`. |

Snapshots are JSON files in `data/chain-snapshots/` named
`snapshot-<ts>.json` so they're recognized by the existing
`pruneSnapshots()` machinery (`src/backup/snapshot-pruner.ts`). Each
snapshot records:

```jsonc
{
  "chain": "journal",
  "takenAt": "2026-04-13T13:14:15.000Z",
  "blockCount": 4321,
  "tailLimit": 1000,
  "head": { /* most-recent block */ },
  "tail": [ /* up to tailLimit trailing blocks */ ],
  "schemaVersion": 1
}
```

Rotation never fails because of a snapshot error — snapshots are
best-effort safety nets, not a source of truth.

## Wiring

`rotateChain()` itself orchestrates the new behavior:

1. Measure chain dir size; bail if under threshold.
2. **Snapshot** trailing blocks to `data/chain-snapshots/` (best-effort).
3. **Archive** the older blocks to `.archives/`.
4. **GC** old archives if `MEMPHIS_CHAIN_GC_ENABLED=true`.

The trigger for `rotateChain()` itself remains operator-driven (CLI or
scheduled task) — automatic rotation hooks are intentionally out of
scope for Sprint 12.

## Tests

- `tests/unit/chain-integrity.test.ts`:
  - tamper detection: flip a byte in a block → `verifyChainIntegrity`
    throws with `hash mismatch`.
  - GC: default-off, deletes only when enabled, respects `gcKeep`.
  - Snapshot: writes well-formed JSON with head + tail; respects tail cap.
  - Three rotations + GC: archive count converges to `gcKeep`; snapshot
    files appear once per rotation; `MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION=false`
    suppresses snapshots.
