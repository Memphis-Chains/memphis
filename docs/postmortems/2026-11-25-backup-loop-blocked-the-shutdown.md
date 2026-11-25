# The backup drill froze the runtime, and a stop became a kill — 2026-11-25

**Status:** resolved
**Severity:** S2 (runtime SIGKILLed; a nightly backup reported a false failure)
**Open items:** 0

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

The chain verifier was the OTHER half of the pause, and it is repaired too.
It used to read and hash every block of a chain in one uninterrupted burst,
which held the event loop for as long as the chain was long — MEASURED on the
live corpus (`patterns`, 5 544 blocks), three runs each: the longest silence
**1 029 / 988 / 963 ms**, and a 20 ms heartbeat that fired 5 times in
2 047 ms instead of 79. The verifier now
reads and validates the blocks in batches of 64 and hands the event loop
back between them, so the pause is bounded by one batch instead of by the
length of the chain: the longest silence fell to **50 ms**, the heartbeat
fired 79 times in 1 947 ms, and the verification took the same time as
before (2 047 ms → 1 947 ms, medians).

Decision #596. Journal #1102.

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
- The remaining 1 842 ms of silence was the chain verifier's block reads, not
  tar. It was not claimed to be zero — and it was later measured on the live
  corpus at ~1 000 ms and repaired (the verifier now hands the event loop
  back between batches; the silence fell to ~45 ms).
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
- **DONE** — the chain verifier hands the event loop back between batches,
  so the runtime stays reachable while it verifies. The longest silence on
  the live corpus fell from ~1 000 ms to ~45 ms, and the verification took
  the same time as before (2 047 ms → 1 947 ms, medians). In the REAL drill,
  on the real archive, the longest silence fell from **921 ms to 115 ms**.
  - **FALSIFIER:** `tests/integration/chain-verify-event-loop.test.ts` asks
    the loop a question every 20 ms and counts the questions ANSWERED
    against the questions ASKED; against the pre-fix code it fails with
    `expected 0.104 to be greater than 0.333` — the loop answered 10 % of
    them, and 95 % after the repair.
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

- [x] **A1.** The chain verifier still reads the corpus one block at a time
      and pauses the runtime's event loop for up to **1 842 ms** during a
      drill. It fits inside the stop budget today (the drain budget is 15 s,
      the stopper budget 5 s, the unit's `TimeoutStopSec` 45 s) and a stop is
      answered inside it — but it is a real pause, it belongs to the storage
      layer rather than to the tar rule, and it is not claimed to be zero.
      **CLOSED 2026-11-25** (decision #596): the verifier reads and
      validates the blocks in batches of 64 and hands the event loop back
      between them, so the pause is bounded by one batch instead of by the
      length of the chain. MEASURED on the live corpus (the `patterns` chain,
      5 544 blocks), three runs each: the longest silence fell from
      **1 029 / 988 / 963 ms to 55 / 44 / 39 ms**, the heartbeat ticks from
      5 of ~100 to 79 of 98, and the verification's own duration did not
      change (2 047 ms → 1 947 ms, medians). AND IN THE REAL DRILL, on the
      real archive (`scheduled-2026-11-25-11-42.tar.gz`, 15 chains and 12 477
      blocks verified): the longest silence fell from **921 ms to 115 ms**,
      the heartbeat answered 549 of 779 questions before and 666 of 758
      after, and the drill took the same time (15 588 ms → 15 178 ms). - **FALSIFIER:** `tests/integration/chain-verify-event-loop.test.ts`
      asks the loop a question every 20 ms while a 5 000-block chain is
      verified, and counts the questions ANSWERED against the questions
      ASKED. Against the pre-fix code it fails with `expected 0.104 to be
  greater than 0.333` — the loop answered 10 % of them; after the
      repair it answers 95 %.
      _Where:_ `readAndValidateChainBlocks` in
      `src/infra/storage/chain-adapter.ts`; the gate is
      `tests/integration/chain-verify-event-loop.test.ts`.
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
- Decision #596, journal #1102 (Memphis chains) — the chain verifier's pause.
- PR #794 — E-08's repair (the drill's verdict) and E-07's `Restart=always`.
- PR #796 — the tar rule (one owner, asynchronous).
- PR #798 — the scratch of a killed drill.
- PR #799 — the chain verifier's pause.
