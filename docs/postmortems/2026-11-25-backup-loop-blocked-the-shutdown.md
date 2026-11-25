# The backup drill froze the runtime, and a stop became a kill — 2026-11-25

**Status:** open
**Severity:** S2 (runtime SIGKILLed; a nightly backup reported a false failure)
**Open items:** 1

## Summary

The runtime was stopped at 02:28:53 CET and killed at 02:29:38 CET. The
shutdown handler **never ran** — not one `shutdown.*` line was written in the
45 seconds in between — and systemd logged `Failed with result 'timeout'`. The
cause was not systemd, and not the restore drill's verdict: the drill called
`execFileSync('tar', ['-xzf', …])`, and a **synchronous** child process holds
the runtime's event loop, and the event loop is what dispatches a signal
handler. The drill's own `tar` was a child of the unit, so the cgroup's
SIGTERM killed it, and the drill reported the tar's death as a failed backup
(`lastError: "Command failed: tar -xzf …"`). A stop that should have taken
two seconds took a SIGKILL, and a backup that was sound was recorded as broken.

## Timeline

All times local (CET), from the unit's own journal on this host:

| time      | event                                                                                      |
| --------- | ------------------------------------------------------------------------------------------ |
| 02:00:05  | `backup.scheduled.start` — the runtime's own scheduled backup begins                       |
| 02:06:39  | `backup.scheduled.success` — `scheduled-2026-11-25-02-00.tar.gz`, 182 229 559 bytes        |
| 02:06:39+ | the restore drill starts; `execFileSync('tar', ['-xzf', …])` holds the event loop          |
| 02:28:53  | `systemd: Stopping memphis.service` — SIGTERM to the cgroup                                |
| 02:28:53+ | **no `shutdown.start`, no `shutdown.exit`** — the handler cannot run while the loop sleeps |
| 02:29:38  | `systemd: State 'stop-sigterm' timed out. Killing.` → SIGKILL                              |
| 02:29:39  | `systemd: Failed with result 'timeout'`                                                    |
| 01:28:55Z | the scheduler task closes with `lastError: "Command failed: tar -xzf …"` (02:28:55 local)  |

A control from the same night, 90 minutes earlier: an ordinary stop at
01:14:57 logged `shutdown.start` and `shutdown.exit` **within two seconds**.
The handler was never broken — the drill was the difference.

## Impact

- The runtime was SIGKILLed rather than drained: no clean shutdown, no drain,
  no operator confirmation that in-flight work had finished.
- The nightly scheduled backup was recorded as **failed**, with a reason that
  was an artefact of the stop rather than a property of the archive. Three
  nights in a row the drill had also reported false failures (that part was
  E-08's repair, PR #794).
- The unit was restarted by systemd, so the service recovered — but by
  SIGKILL, not by the drain path the operator's `systemctl stop` expects.

**Severity S2**: no data loss was observed, and the service came back. The
drain path was unavailable exactly when it was needed, and the incident
reported a false failure to the operator.

## The live test — 25.11, 10:41

The repair was verified on the **running service**, not only in a harness: the
scheduled backup was triggered through the scheduler's own API, and a SIGTERM
was aimed at the drill while it was extracting.

| time     | event                                           |
| -------- | ----------------------------------------------- |
| 10:41:52 | `backup.scheduled.start`                        |
| 10:42:35 | `backup.scheduled.success` — 182 605 156 bytes  |
| 10:42:42 | the drill's `tar -xzf` starts                   |
| 10:42:42 | **SIGTERM** — the same second as the extraction |
| 10:42:46 | `shutdown.exit exitCode=0 drained=true`         |

The stop was answered in the same second it was sent, and the unit drained
cleanly. That is the case this incident was filed about, measured on the
service that had the defect.

**AND THE TEST FOUND SOMETHING ELSE.** The drill's scratch directory is
removed in a `finally`, and a `finally` does not run when the process is
killed. The live test therefore left `memphis-verified-drill-Jsb39N` behind —
**489 MB and 13 002 files**, measured on this host — in the backups root, and
nothing in the runtime collected it. A drill that is stopped leaves a corpse,
and there was nothing to bury it.

## Root cause — VERIFIED

`execFileSync` blocks the calling thread until the child process exits. In the
CLI that thread is the **runtime's** event loop, and the runtime is the
process systemd stops. A SIGTERM delivered while the loop is blocked cannot
be dispatched, because dispatching it is the event loop's job.

Measured on this host, on the real 181 MB archive:

|                                  | before             | after                                      |
| -------------------------------- | ------------------ | ------------------------------------------ |
| the drill's longest silence      | **11 302 ms**      | **1 842 ms** (the chain verifier, not tar) |
| heartbeat ticks during the drill | 35 of 336 (10.4 %) | **520 of 693 (75 %)**                      |
| a SIGTERM aimed at the drill     | **never answered** | answered in **1 ms**, clean exit 0         |

A standalone reproduction of the mechanism, on the same archive: a synchronous
tar of 3 565 ms produced **0** heartbeat ticks and the SIGTERM handler **never
ran**; the asynchronous form produced 10 ticks and answered the signal with a
delay of **0 ms**.

## Resolution

`scripts/backup-tar.mjs` is now the **one owner** of the tar rule — how tar is
invoked, how its failures are read, how its stderr reaches the operator — and
every call through it is asynchronous. The two runners (the compiled CLI, which
the runtime calls from inside its own event loop, and the plain-Node systemd
runner) had already drifted: the CLI classified tar's failures one way and the
runner re-implemented the "file changed as we read it" rule inline and dropped
the reason from the message. tar's capability probes moved with it, and the
archive digest now streams instead of pulling 182 MB into the heap.

Decision #594. Journal #1100. E-07's and E-08's entries in the error ledger
carry the full record.

The scratch of a killed drill is now buried by the **next** drill, and only
when it can be PROVED to be a corpse. The scratch's name carries the pid of
the process that owns it, so the kernel can be asked whether that owner still
exists — ESRCH means it is gone, EPERM means it is alive and the scratch is
left alone. For the scratch of a drill that ran before the name carried the
owner, the directory's own **ctime** is the proof: it is the last time an
entry was created inside it, which is the extraction. tar RESTORES the mtime,
so the mtime points at the ARCHIVE's time and says nothing about the drill;
the ctime cannot be forged by tar.

Decision #595. Journal #1101.

## Anti-confab — what we are NOT claiming

- **NOT** a systemd defect. `TimeoutStopSec=45` behaved exactly as
  configured; the handler simply had no chance to run.
- **NOT** an out-of-memory kill. The unit's `MemoryMax` was not reached —
  systemd's own message was `State 'stop-sigterm' timed out`, and the
  `SIGKILL` followed the stop timeout, not an OOM event.
- **NOT** a corrupted archive. `tar -xzf` of the same archive exits 0 and
  yields 486 MB; the drill's failure text was the tar's death by SIGTERM.
- **NOT** the same cause as E-08's false failures. E-08's repair fixed the
  drill's **verdict**; this incident is about the drill's **timing**, and it
  survived that repair unchanged.
- The remaining 1 842 ms of silence is the chain verifier's block reads, not
  tar. It is not claimed to be zero.
- **NOT** a disk-space incident that happened in production. The 489 MB
  corpse was left by the live stop-during-drill **test** on this host,
  minutes after the repair was verified; it was removed by hand. The rule
  that buries such corpses now ships, and its gate can fail.

## Lessons learned — action items

- **DONE** — the tar rule has one owner, and every call through it is
  asynchronous (`scripts/backup-tar.mjs`, `src/infra/cli/commands/backup-tar.ts`).
- **DONE** — the archive path no longer waits on a child process
  synchronously; the contract gate names the files the rule covers.
- **DONE** — the gate can fail: `tests/integration/backup-event-loop.test.ts`
  installs a `tar` shim that sleeps and marks its own window; against the
  pre-fix code both cases fail with `expected 0 to be greater than 0`.
- **DONE** — the live stop-during-drill test on the RUNNING service:
  `backup.scheduled.start` at 10:41:52, the extraction and the SIGTERM in the
  same second (10:42:42), `shutdown.exit exitCode=0 drained=true` at 10:42:46.
  The case this incident was filed about, measured on the service that had
  the defect.
- **DONE** — the scratch of a killed drill is buried by the next drill, and
  only a scratch that can be proved abandoned is touched.
  - **FALSIFIER:** against the pre-fix code the burial case fails with
    `expected true to be false` — the corpse survived the drill that should
    have buried it; and the "the owner is alive" case fails when the
    liveness proof is mutated away. The gate can fail in both directions.

## Open items

This section is the machine-readable one: `npm run -s ops:audit` counts its
unchecked boxes and compares the count with the `**Open items:**` header
above. A document whose header contradicts this list is reported as
inconsistent, so the two cannot drift apart silently.

- [ ] **A1.** The chain verifier still reads the corpus one block at a time
      and pauses the runtime's event loop for up to **1 842 ms** during a
      drill. It fits inside the stop budget today (the drain budget is 15 s,
      the stopper budget 5 s, the unit's `TimeoutStopSec` 45 s) and a stop is
      answered inside it — but it is a real pause, it belongs to the storage
      layer rather than to the tar rule, and it is not claimed to be zero.
      _Where:_ `verifyChainIntegrity` in `src/infra/storage/chain-adapter.ts`.
- [x] **A2.** The scratch of a drill that was killed was left in the backups
      root forever — **489 MB and 13 002 files**, measured on this host after
      the live stop-during-drill test. The drill removed it in a `finally`,
      which does not run when the process dies, and nothing else collected
      it. The scratch's name now carries the pid of the process that owns it,
      and the next drill buries the corpses it can PROVE are corpses: the
      owner is gone according to the kernel, or the scratch carries no owner
      and its ctime — the extraction — is older than the drill's longest
      measured runtime. A scratch whose owner is alive is never touched.
      _Where:_ `reapDeadDrillScratch` in `src/infra/cli/commands/backup.ts`;
      the gates are `tests/integration/backup-content-drill.test.ts` and
      `tests/unit/backup-drill-scratch.test.ts`.

## Related

- [The error ledger](../design/MEMPHIS-ERROR-LEDGER.md) — E-07 and E-08.
- [CHANGELOG](../../CHANGELOG.md) — "The backup path froze the runtime — and
  that is why a stop became a kill".
- Decision #594, journal #1100 (Memphis chains) — the tar rule.
- Decision #595, journal #1101 (Memphis chains) — the scratch of a killed drill.
- PR #794 — E-08's repair (the drill's verdict) and E-07's `Restart=always`.
