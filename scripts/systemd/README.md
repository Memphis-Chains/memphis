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
default — to get `lr-dashboard.service` installed and running, run
`scripts/systemd/install-managed-app-units.sh` (see below). The other three
have no installer yet and are copied by hand.

### Managed app units (`lr-dashboard.service`)

```bash
bash scripts/systemd/install-managed-app-units.sh
```

This creates the state directory the unit logs into, copies the unit only if
it differs, and enables/starts it. Idempotent — a second run reports
`unchanged`.

The state directory is not optional decoration: `StandardOutput=append:` does
not create missing parent directories, and systemd opens stdout **before**
running `ExecStartPre`. A missing directory therefore fails the unit at step
STDOUT with `209/STDOUT` before `ExecStart` is ever reached, and with
`Restart=on-failure` the unit loops. Measured 2026-10-08: 325 restarts in
12 hours. Do not try to fix this with an `ExecStartPre=mkdir` — that process
dies at STDOUT too.

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

### Failure alerts (`memphis-monday-admin-failure-alert.service`,
### `memphis-tuesday-code-failure-alert.service`)

These two units are the `OnFailure=` targets of the Monday admin digest and
the Tuesday code digest. They exist so that a failed digest reaches the
operator instead of dying silently.

They shipped as a 71-byte stub — `[Unit]` + `Description`, no `[Service]`
section — so systemd refused to run them on every boot:

```
Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.
```

The `OnFailure=` wiring in the parent units was correct all along; only the
alert side was missing. The result was the worst possible failure mode: the
units whose whole job was to report a failure could not report one.

Both now run `scripts/systemd/failure-alert.sh`, which:

- delivers the alert to Telegram through the `memphis` CLI, because the bot
  token is vault-backed (`MEMPHIS_TELEGRAM_BOT_TOKEN` in `.env` is the
  literal `VAULT:telegram_bot_token`) and only the CLI resolves that
  reference — the literal must never reach the Telegram API;
- throttles to one message per failed unit per hour
  (`MEMPHIS_ALERT_THROTTLE_SECONDS`, default 3600). The stub was started in
  bursts — five attempts within three seconds on 2026-10-23, and once per
  boot on 2026-10-24 — so an unthrottled alert would bury the operator;
- always writes the full failure detail to the journal, whether or not the
  message was sent.

The alert unit is not chained to anything further, so a failed alert cannot
escalate into a second failed unit.

To install:

```bash
cp scripts/systemd/memphis-*-failure-alert.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

### The unit gate

`scripts/check-systemd-units.mts` (`npm run -s ops:check-systemd-units`)
fails when a `.service` has no `ExecStart=`/`ExecStop=`, when an
`OnFailure=` target does not exist, or when the target is itself a stub.

The fix restores two `ExecStart` lines; the gate is what stops the next
stub unit from shipping the same way, and what catches an `OnFailure=`
target that reports a failure into the void. It runs in CI
(`quality-gate`) and in `.githooks/pre-commit` when a unit file is staged.
