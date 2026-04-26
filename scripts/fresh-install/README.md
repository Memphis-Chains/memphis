# Fresh-install + restore audit

`06-fresh-install-and-restore.sh` is the operator-facing runbook for
auditing Memphis's full install + recovery path on a single host.

## What it does

1. **Snapshot** — `memphis backup create --tag pre-fresh-install`,
   copies the resulting tarball + checksum out to a portable location
   (`$BACKUP_OUT`, default `~/memphis-fresh-install-snapshot/`).
2. **Pepper reminder** — writes `PEPPER-REMINDER.txt` to the snapshot dir.
   The backup archive does **not** contain the vault pepper (by design);
   you save that externally.
3. **Tear-down** — interactive `TEAR-DOWN` prompt, then `rm -rf` of the
   data dir and repo checkout.
4. **Fresh install** — runs `bash scripts/install.sh` (or a remote
   installer URL if `INSTALL_SCRIPT_URL` is set).
5. **Restore** — `memphis backup restore --pepper-restore <pasted>`.
   Pepper read via `read -s` so it never lands in scrollback.
6. **Smoke** — `memphis init status`, `memphis vault list`,
   `memphis health`, `memphis doctor`, plus a best-effort
   `memphis ask "ping"` to validate the provider stack end-to-end.

## Why

Closes the gap between "memphis backup works" (unit-tested) and
"memphis fresh-install + backup-restore actually produces a working
bot on a clean host" (never previously validated end-to-end).
Surfaces every dependency the install scripts assume but don't
auto-install, every vault/chain path the restore mechanism misses,
and every operator action that today requires tribal knowledge.

## Operator workflow

```bash
# Step 1 — make sure your pepper is saved externally:
grep MEMPHIS_VAULT_PEPPER ~/memphis/.env  # → save to KeePass

# Step 2 — run the audit:
bash scripts/fresh-install/06-fresh-install-and-restore.sh

# Or from the pendrive pack:
bash /mnt/usb/usb2-watra-pack/04-migration/06-fresh-install-and-restore.sh
```

The script is **idempotent** — if it aborts at step N, fix the issue
and re-run. It picks up where it left off.

## Configuration via env

| Variable | Default | Meaning |
|---|---|---|
| `MEMPHIS_INSTALL_BASE` | `~/.memphis` | Where the CLI links to |
| `MEMPHIS_TARGET_DIR` | `~/memphis` | Repo checkout location |
| `MEMPHIS_DATA_DIR` | `~/.memphis` | Vault + chains + sqlite root |
| `BACKUP_TAG` | `pre-fresh-install` | Tag passed to `memphis backup create` |
| `BACKUP_OUT` | `~/memphis-fresh-install-snapshot` | Where the snapshot is staged |
| `INSTALL_SCRIPT_URL` | (empty) | If set, curl-installs from this URL instead of the local repo |

## Failure modes

- **Pepper mismatch at restore.** If the pasted pepper is the wrong
  one for the vault state in the snapshot, vault decryption fails —
  vault entries are unreadable but everything else (chains, sqlite,
  embeddings) is restored. Recover by re-running step 6 with the
  correct pepper or via `memphis vault recovery-unlock`.
- **Provider not configured post-restore.** Step 8 will warn but not
  fail. After restore, `memphis providers list` shows what's wired;
  add API keys via `memphis vault add` if needed.
- **systemd unit can't start.** The script doesn't restart the user
  unit at the end. Run `systemctl --user start memphis` manually
  after step 8 if you want the daemon up.

## Tested on

- Operator's `memphis@memphischains` host, 2026-04-26 sprint cycle.

If you hit a real bug not covered by the warnings above, file a PR
matching the operator's bundled-Codex-hotfix pattern.
