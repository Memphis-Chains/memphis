# Quarterly Restore Drill

Proves backups are restorable + chain integrity verifies on a fresh runtime tree. Run quarterly so the first time you discover a broken backup is *not* the day a disk dies.

## What it does

`scripts/quarterly-restore-drill.sh` runs five steps end-to-end:

1. Take a fresh backup tagged `quarterly-drill-<UTC date>`.
2. Verify the backup file passes integrity check.
3. Restore the backup into an isolated `mktemp` directory (operator's runtime untouched).
4. Run `memphis chain verify` against the restored tree.
5. Run `memphis chain rebuild` and count chains as a smoke signal.

Any step failing exits non-zero with `[FAIL] ...`. Successful runs end with `[PASS] quarterly-restore-drill complete`.

The temporary restore directory is cleaned via `trap cleanup EXIT`, regardless of outcome.

## Manual run

```bash
./scripts/quarterly-restore-drill.sh
```

Optional: `MEMPHIS_DRILL_TAG=adhoc-2026-04-29` to override the backup tag.

## Recommended cron registration

Run quarterly at 4 AM on the first day of every third month:

```bash
memphis cron add \
  --type shell \
  --cron "0 4 1 */3 *" \
  --name quarterly-restore-drill \
  --script "$(pwd)/scripts/quarterly-restore-drill.sh"
```

Inspect with `memphis cron list`. Failures land as `[FAIL] ...` lines in the cron task output and surface via `memphis_health` as `cron.failure` events on the system chain.

## What this drill does NOT cover

- It runs the backup restore, but does not actually boot a Memphis daemon against the restored tree (skips fastify listen, channel gateway, scheduler). Boot-time drills live in `scripts/drill-vault-runtime-recovery.sh`.
- It does not exercise vault unlock with a recovered passphrase. Test that path manually with `memphis vault recovery-unlock` after a real recovery.
- It does not validate cross-version compatibility (chain blocks written by v1.6 restored on v1.8). That's covered by `tests/integration/chain-format-compat.test.ts` (Track C4).

## When this drill fails

`[FAIL] backup verify rejected ...` — the backup file is corrupt. Check disk health and recent backup logs (`memphis audit search --action backup.create.failed`).

`[FAIL] restore failed` — schema migration may have shifted between backup time and now. See `docs/dev/MIGRATIONS.md` and `memphis chain migrate --apply`.

`[FAIL] chain verify rejected` — chain integrity is compromised in the restored tree. Open an incident and run `memphis chain verify --json` against the live runtime to compare.
