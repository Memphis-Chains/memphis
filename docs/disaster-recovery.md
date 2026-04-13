# Disaster recovery

This runbook covers the recovery paths for the failure modes Memphis can
hit on a single host. Pair it with the operator key lifecycle runbook
(`docs/key-lifecycle.md`) and the chain integrity notes
(`docs/chain-integrity.md`).

## Daily backup

```
memphis backup
```

Writes `~/.memphis/backups/backup-<ts>.tar.gz` plus a `.sha256` sidecar.
Manifest at `~/.memphis/backups/manifest.json` tracks every archive with
checksum, size, and tag. Backups exclude `cache/`, `logs/`, and lock
files.

## List & verify

```
memphis backup list
memphis backup verify <file-or-tag>
```

Verify recomputes the SHA-256 of the archive, compares against the
sidecar, and lists archive contents. Use this before every restore.

## Restore (same host)

```
memphis backup restore <file-or-tag> --yes
```

Steps under the hood:
1. Verify the archive checksum matches the sidecar.
2. Take a `pre-restore-<ts>` safety backup of the current state.
3. Extract the archive to a temp dir.
4. Atomically swap current `~/.memphis/*` (excluding `backups/`) with
   the extracted contents.
5. Re-verify the archive against the sidecar after restore.

If anything fails between step 3 and 4 the original contents are
restored from the temp dir and the restore aborts.

## Restore (cross-host with vault)

The vault's master key is encrypted with the host's
`MEMPHIS_VAULT_PEPPER`. When restoring to a host whose pepper differs
from the source, the vault won't decrypt and `memphis vault list`
returns `vault_decrypt_failed`.

```
memphis backup restore <file> --yes --pepper-restore <source-pepper>
```

`--pepper-restore` writes the supplied pepper into the restored `.env`
so the vault stays decryptable. The pepper is **never echoed** in any
restore output.

After restoring with the source pepper:
1. Verify with `memphis vault list` (metadata only) and `memphis doctor`
   (cipher cycle probe).
2. Rotate the pepper to one unique to the destination host with
   `memphis vault pepper-rotate` (Sprint 1) so the source pepper can be
   safely retired from the password manager.

## When the vault won't decrypt

Causes, from most to least common:

- The destination host's `MEMPHIS_VAULT_PEPPER` differs from what the
  vault was encrypted with — see the cross-host restore path above.
- The pepper was rotated *outside* `memphis vault pepper-rotate` (i.e.
  edited in `.env` directly). The vault is recoverable only with the
  prior pepper.
- The vault state file is corrupted — restore from the most recent
  backup.

Do not delete `data/vault-state.json` or `data/vault-entries.json` to
"start fresh" — they hold the only copies of every secret. Always keep
the dead vault around (rename to `data/vault-bak-<ts>/`) until the
recovery is validated.

## When the chain is corrupted

```
memphis chain verify [--chain <name>]
```

A `hash mismatch` error names the offending block file. Options:

- If the corruption is in an active block (in `chains/<name>/`),
  restore from the most recent backup.
- If it's in an archived chunk (in `chains/.archives/`), the active
  chain is unaffected. The archive is still recoverable via the
  pre-rotation snapshot at `data/chain-snapshots/snapshot-<ts>.json`
  (Sprint 12) — match the snapshot timestamp to the rotation time.

## When an archive is truncated

Treat as missing: the active chain doesn't depend on archives. Replace
the archive from a backup if you need historical reads, or accept the
loss and continue.

## CI restore drill

`.github/workflows/restore-drill.yml` runs nightly and exercises the
full path on a throwaway runner: write fixture data, take a backup,
wipe, restore, assert content survival. Failures page whoever's on the
release rotation.

The drill is the test that says "restore works **today**." Without it,
the only signal that restore is broken is finding out you can't recover
when you actually need to.

## Recovery time targets

| Scenario | Target |
|---|---|
| Same-host restore from local backup | < 60 seconds for typical (~50 MB) archive |
| Cross-host restore with `--pepper-restore` | Same as above + manual pepper rotation |
| Chain-only recovery from snapshot | < 5 seconds (snapshot-driven) |
| Vault recovery with passphrase + recovery Q/A | < 30 seconds (Sprint 1's `vault recovery-unlock`) |

These targets are exercised by the round-trip integration test
(`tests/integration/backup-restore-drill.test.ts`); regressions surface
in CI.
