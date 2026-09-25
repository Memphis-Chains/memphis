# `scripts/systemd/` — Operator-side systemd user units

The `.service` and `.timer` files in this directory are installable copies
of the per-machine units that drive the Memphis runtime's background loops.

These were previously installed only at `~/.config/systemd/user/` on the
operator's box (a one-off, non-reproducible state). Codifying them here
means a fresh operator install boots the same cron shape:

- `memphis-chain-integrity-sweep.{timer,service}` — runs `scripts/chain-integrity-sweep.mjs`
  hourly (with 0–5 min jitter). Detects chain-corruption class of bug
  (decisions #98, #146) within an hour rather than at next TUI session.
- `memphis-wal-checkpoint.{timer,service}` — runs `scripts/wal-checkpoint.mjs`
  every 6 hours. Prevents `file changed as we read it` errors during backups
  and bounds WAL size.

The two `.service` files are intentionally `Type=oneshot` with `Restart=no`;
they're idempotent probes, not long-running services. Both read-only against
chains and the WAL respectively — they do not modify state.

Other `.service` files in this directory (`memphis-camera-preview.service`,
`memphis-whisper-stt.service`, `memphis-piper-tts.service`,
`lr-dashboard.service`) are operator-machine media/UI captures, also
codified here so a reinstall doesn't lose them. They are NOT installed by
default — see per-service README below if you want them.

## Install (Linux / WSL)

```bash
# One time per machine.
cp scripts/systemd/memphis-*.{timer,service} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now memphis-chain-integrity-sweep.timer
systemctl --user enable --now memphis-wal-checkpoint.timer
```

## macOS

`memphis service install` wires a different mechanism (a packaged macOS
launchd plist, not systemd). The Linux `.timer` units are intentionally
absent on macOS; the WAL checkpoint is invoked at boot via the macOS
launchd path instead. Skip this directory on macOS.

## Verify

After install on Linux:

```bash
# List enabled timers — expect both memphis timers within 5 min + jitter.
systemctl --user list-timers --all | grep memphis

# Force a one-shot run of the sweep to confirm health.
systemctl --user start memphis-chain-integrity-sweep.service
journalctl --user -u memphis-chain-integrity-sweep.service -n 50
```

Exit code from the sweep:

- `0` — every block in scope parses with required fields
- `1` — at least one block failed (details on stderr)
- `2` — chains directory is missing or unreadable

On `exit 1`, the chain-integrity-sweep has detected a corruption. Read the
JSON entries written to stderr, identify the offending block by
`chain` + `file`, and run `memphis chain rebuild --out <path>` to
investigate.

## Why `Wants=memphis.service` and not `Requires=`

If `memphis.service` is down, the sweep should still run — it's a
read-only probe against the chains directory, which is on local FS and
not gated by the runtime. `Wants=` is the soft dependency that allows
parallel startup without ordering pain. If the chains directory is on
a network mount that's only mounted when `memphis.service` runs, swap
to `Requires=` and add `After=memphis.service` to the `[Unit]` section.
