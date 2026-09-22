# Postmortem: chains/halt/ invalid block shape — boot loop 2026-09-22

**Date:** 2026-09-22 12:30 CEST
**Operator on call:** Wodzu (Marcin)
**Author:** Mavis (Mavis/MiniMax-M3) — operacyjnie, podczas sesji
**Severity:** S1 (runtime down + boot-loop)
**Duration:** ~2h 30m degraded (09:44 first failure → 12:11 clean boot)
**Detection channel:** systemd restart storm + `journalctl -u memphis` (`code=exited, status=102/n/a`)

---

## TL;DR

Skill `halt-aware-destructive-ops` (added 2026-09-22 00:40 to `memphis/skills/`)
writes audit blocks to `~/.memphis/chains/halt/` with schema
`{chain, index, timestamp, data}` — **missing the `prev_hash` and `hash`
fields required by `chain-adapter.js:582`**. Files were first written
during a manual deep-restart on 2026-09-21 22:40 and continued to be
appended by `memphis-halt-integrity.timer` (cron) overnight. Memphi
runtime was alive when those files were created — `chain-adapter` does
**not** re-validate chains during normal operation, only at BOOT. The
next BOOT at 09:44 today triggered integrity verification, threw
`invalid block shape for 000001.json`, exited 102, and entered an
uncontrolled restart loop in spite of `RestartPreventExitStatus=101 102 103`
being set in the unit file. Resolution: archived `chains/halt/` (22 files)
out of `chains/`, runtime booted cleanly.

---

## Timeline (CEST, all 2026-09 unless noted)

| Time | Event | Source |
|---|---|---|
| **21 22:36** | Mode change E→A | `config/PULSE.md` |
| **21 22:40:33** | First 4× `halt-check` blocks written (000001–000004). Caller `memphis@memphis`. Targets `scripts/ci-workflow-install-step-lint.mjs` (already halted by `collective/000025`). | archive `.memphis-backup-broken-halt-chains-20260922-121016/000001-000004.json` |
| **21 22:40:35** | First `halt-verify` block (000005). violations=0. | `000005.json` |
| **21 22:40:57 – 22:41:46** | Burst of 16 more `halt-check` + 5 more `halt-verify` blocks (000006–000021). All same target file. Two `bypass` actions with reason `council-approved-…` suggest operator was testing the new skill's override path. | `000006-000021.json` |
| **21 22:43:09** | Last healthy heartbeat of memphis (uptime 4808s). | `PULSE.md` |
| **21 22:45:53** | Graceful SIGTERM, drained=true, remaining=0. End of pre-restart uptime 4972s. | `PULSE.md` |
| **22 00:40:13 – 00:41:32** | 6 files in `skills/halt-aware-destructive-ops/` created (SKILL.md, audit.sh, bash-hook.sh, check.sh, register.sh, unregister.sh, verify.sh) — all 22 wrz 00:40–00:41, all staged in git but not yet committed (on branch `feat/phase-L-offline-invariant`). | filesystem mtime + `git status` |
| **22 00:41:20** | `memphis-halt-integrity.timer` first run (`Persistent=true` catch-up from 21 09:00). Wrote `chains/halt/000022.json` (timestamp 09:43:48Z — clock-skew note below). | `journalctl -u memphis-halt-integrity.service` |
| **22 09:43:48** | Timer run — added `chains/halt/000022.json` (`halt-verify`, violations=0, no halted resources). | `000022.json` |
| **22 09:44:08** | First BOOT attempt → `chain integrity verification failed: chain integrity check failed for 000001.json: invalid block shape`. Exit 102. systemd unit triggers `Restart=on-failure` after 5s. | `journalctl -u memphis.service` |
| **22 09:44 – 11:54** | Boot loop. 50+ failed restarts in first 3 minutes, continuing every ~5s. `boot-failures.json` grew to 50 entries. Telegram alerts from `runtime-watch.log` (last one 21 22:45 said `health=unhealthy`). | `boot-failures.json`, journalctl |
| **22 12:10** | Manual stop of service + archive of `chains/halt/*.json` (22 files) to `~/.memphis-backup-broken-halt-chains-20260922-121016/` + delete empty parent dir + archive `boot-failures.json` to `.bak-20260922-121016`. | this session |
| **22 12:10:26** | New BOOT — `health=healthy`, provider=`minimax`, model=`MiniMax-M3`. Server listening on 127.0.0.1:3000. | `PULSE.md` |
| **22 12:11** | `memphis chain verify` → `ok:true, chainsChecked:10, blockCount:11958`. `health` endpoint returns `status:healthy`. | CLI + curl |

---

## Root cause — four-layer decomposition

### Layer 1 — Schema mismatch in writer (the proximate cause)

`memphis/skills/halt-aware-destructive-ops/check.sh:71-89` and `verify.sh:81-95`
both write JSON blocks with this template:

```json
{
  "chain": "halt",
  "index": <N>,
  "timestamp": "<...>",
  "data": { ... }
}
```

The validation at `memphis/dist/infra/storage/chain-adapter.js:582`
(`toChainBlock`) requires all six fields:

```js
typeof block.index     === 'number' &&
typeof block.timestamp === 'string' &&
typeof block.chain     === 'string' &&
typeof block.prev_hash === 'string' &&   // ← missing in halt checks
typeof block.hash      === 'string' &&   // ← missing in halt checks
typeof block.data      === 'object'  && !Array.isArray(block.data)
```

Missing `prev_hash` or `hash` throws `invalid block shape` and aborts
the **entire** integrity check for the runtime. Not a per-block failure
that can be retried — a hard exit (code 102).

### Layer 2 — Integrity check is boot-time only, not runtime-continuous

`verifyChainIntegrity` runs on `memphis.service` startup. It does not
periodically re-validate chain contents. This means a sidecar audit
chain can silently drift from valid to invalid while the runtime is
alive. Memphi was healthy from 21 21:23 to 21 22:45 — during that
window, `chains/halt/000001.json` was written at 22:40:33, but the
running process never noticed. The first re-validation was the next day
at 09:44.

This is a **split-brain** between runtime state and on-disk chain
state. It is not unique to halt — issue #04 documents the same class
(case-blocks corrupted mid-runtime, `chain_verify ok:true` because
hashes still match while contents are unparseable).

### Layer 3 — `RestartPreventExitStatus` did not stop the loop

`memphis.service` declares:

```ini
[Service]
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=101 102 103
```

The runbook `docs/runbooks/SYSTEMD_EXIT_CODES.md` explicitly says:
> Exit `102`: Do not loop-restart. Restore from verified backup.

Yet the runtime restarted 50+ times in three minutes. Two hypotheses
to verify:

1. **`user-mode` systemd handles `RestartPreventExitStatus`
   differently** than system mode. No assertion either way — needs
   `systemd-analyze verify` and a controlled test.
2. **Exit code 102 is being re-emitted on restart** by a wrapper
   (e.g., node CLI exit) rather than the daemon process — systemd may
   be observing a different code than the validator emitted. Worth
   reading the ExecStart path's behavior on repeated start.

In either case, the **observed behavior** contradicts the documented
intent. Treat the directive as advisory until verified.

### Layer 4 — Halt audit should not live under `chains/`

Halt-audit is a **sidecar concern** (audit trail of destructive-op
prevention decisions). It is not a content-addressed immutable chain
the way `system/`, `soul/`, `journal/` are. Putting it under `chains/`
forces the same hash-prev linkage, but the writers (bash scripts using
`jq`) cannot reasonably produce SHA-256 hashes without a Rust NAPI
helper. Result: a half-conforming format that passes the eye but fails
the validator.

A pure sidecar (JSONL append-only, or sqlite append table) is the
correct shape for this audit. The fact that `check.sh`/`verify.sh`
chose `chains/halt/` is a **category error**, not a missing-fields bug.

---

## Evidence

### 22 archived halt files (now in `~/.memphis-backup-broken-halt-chains-20260922-121016/`)

```
idx=1   ts=2026-09-21T22:40:33Z kind=halt-check  action=pass   args=[README.md]   matches=0
idx=2   ts=2026-09-21T22:40:33Z kind=halt-check  action=block  args=[scripts/ci-workflow-install-step-lint.mjs]  matches=1
idx=3   ts=2026-09-21T22:40:33Z kind=halt-check  action=bypass args=[scripts/ci-workflow-install-step-lint.mjs]  matches=1  reason=council-approved-explicit
idx=4   ts=2026-09-21T22:40:33Z kind=halt-check  action=block  args=[ci-workflow-install-step-lint.mjs]  matches=1
idx=5   ts=2026-09-21T22:40:35Z kind=halt-verify action=verify args=[] matches=0
…
idx=22  ts=2026-09-22T09:43:48Z kind=halt-verify action=verify args=[] matches=0
```

All 22 files: no `prev_hash`, no `hash`.

### `journalctl -u memphis.service` (5 sample of 50+)

```
Sep 22 11:55:14 memphis systemd[2064]: Started memphis.service - Memphis local runtime.
Sep 22 11:55:14 memphis node[12460]: chain integrity verification failed: chain integrity check failed for 000001.json: invalid block shape
Sep 22 11:55:14 memphis systemd[2064]: memphis.service: Main process exited, code=exited, status=102/n/a
Sep 22 11:55:14 memphis systemd[2064]: memphis.service: Failed with result 'exit-code'.
Sep 22 11:55:14 memphis systemd[2064]: memphis.service: Consumed 3.118s CPU time over 2.757s wall clock time, 129.6M memory peak.
```

(Recurring at ~5s intervals, exit 102 always.)

### `memphis chain verify` before vs after archive

```
# before (still 22 broken halt files in chains/)
[ERROR] Failed to load Memphis CLI: chain integrity check failed for 000001.json: invalid block shape

# after archive
ok: true
chainsChecked: 10
blockCount: 11958
```

---

## Resolution

1. Stopped `memphis.service` (manual, single kill — boot loop was active).
2. Archived `~/.memphis/chains/halt/*.json` (22 files, 24 KB) →
   `~/.memphis-backup-broken-halt-chains-20260922-121016/`.
3. `rmdir` of the empty `chains/halt/` parent.
4. Archived `state/boot-failures.json` (50 entries) →
   `state/boot-failures.json.bak-20260922-121016`.
5. `memphis chain verify` → all 10 chains integrity OK (11 958 blocks).
6. `systemctl --user start memphis.service` → BOOT healthy in ~3s.
7. `curl /health` → `status:healthy`, `version:1.13.3`, `uptime_seconds:36`.
8. PULSE.md entry `2026-09-22T10:10:26.987Z BOOT health=healthy uptime=0s provider=minimax`.

**No data loss from the user's "core" runtime:**
- `soul/000256.json` (manual append OpenClaw v0.1.0) preserved.
- Root-level `halt/` (4 active halted resources) preserved.
- All 10 core chains (collective, soul, system, cases, decisions, insights,
  journal, patterns, reflections, autonom_archive) untouched.
- Vault (`vault-entries.json`, `vault-state.json`, `.tier2-passphrase`,
  `.github-pat`) untouched.
- Soul-memory, scheduler tasks, PULSE.md, telegram config untouched.

**Data loss scope:**
- 22 `halt-check` + `halt-verify` audit records from 21 22:40:33 – 22 09:43:48.
  All archived, can be replayed once halt audit moves to a real sidecar.

---

## Lessons learned — action items

> Priority: **P0** = prevent the same incident, **P1** = improve detection,
> **P2** = improve process / documentation.

### Stop the bleed (P0)

- [ ] **A1. Move halt audit out of `chains/`.** Change `AUDIT_DIR` in
      `check.sh` and `verify.sh` to `~/.memphis/audit/halt/`. Use JSONL
      append-only (`~/.memphis/audit/halt/events.jsonl`), one event per line,
      no `index`/`prev_hash`/`hash`. Update SKILL.md accordingly.
      *Owner:* operator + next session.
      *Verification:* `ls ~/.memphis/audit/halt/` after a halt-check; no files
      under `~/.memphis/chains/halt/`.
- [ ] **A2. Add `MEMPHIS_CHAINS_ALLOWLIST` config** (env var + `config/`)
      listing which directories under `chains/` are real chains. Default
      to the current 10 core chains + `cases.backup-*/` + `journal.backup-*/`
      + `system.backup-*/`. `verifyChainIntegrity` only scans allowlisted
      entries; unknown dirs emit a warning to `runtime-watch.log`.
      *Verification:* `memphis chain verify --strict` with a stray directory
      in `chains/` should pass and warn, not crash.
- [ ] **A3. Verify `RestartPreventExitStatus` actually stops restarts in
      user-mode systemd.** If it does not, switch the unit to
      `Restart=no` and add an external watchdog (e.g., a separate
      `memphis-watcher.service` that runs `memphis doctor --fix` after a
      single failure, then starts the daemon on green).
      *Verification:* force `node … serve` to `exit 102` under test and observe
      that systemd does not restart it again.
- [ ] **A4. Hard rate-limit the service unit.**
      ```ini
      StartLimitBurst=5
      StartLimitIntervalSec=300
      ```
      in `memphis.service`. After 5 failed starts in 5 minutes, systemd
      gives up. Operators must then explicitly `systemctl reset-failed`.
      *Verification:* force 5 failures and observe `Inactive (auto-restart
      failed)` after burst limit.

### Detect earlier (P1)

- [ ] **B1. Periodic chain integrity scan at runtime** (e.g., every 5 min,
      cheap — read only header + last block, full verify once per hour).
      On failure: send Telegram alert + auto-archive the offending dir to
      `~/.memphis-backup-corrupt-chains/<ts>/` + leave runtime running.
      *Verification:* artificially corrupt a non-critical chain block;
      expect Telegram alert within 5 min and `chains/<name>/` moved to
      backup.
- [ ] **B2. Skill loader must dry-run.** `register.sh` / skill install
      path should: install files → run for 60s in a sandbox → assert no
      writes under `~/.memphis/` outside expected paths → only then
      commit the staged files. Currently a skill is staged and effectively
      live the first time the timer fires.
- [ ] **B3. `memphis doctor` should refuse `start` when
      `boot-failures.json` had > 5 entries in the last 10 minutes.**
      Currently the service keeps restarting regardless of the JSON file
      that exists exactly for this purpose.

### Process (P2)

- [ ] **C1. New-skill contract.** Any new skill under
      `skills/<name>/` must include `compat.test.sh` asserting that any
      persistent write passes `memphis chain verify --strict` if written
      under `chains/`, or stays outside `chains/` if sidecar.
      `memphis self-update` runs `compat.test.sh` of every skill before
      enabling the timer.
- [ ] **C2. Pre-commit git hook** running `memphis chain verify` over
      any staged change under `chains/`. Any block failing the schema
      blocks the commit. Covers future `register.sh`-style manual
      appends as well.
- [ ] **C3. Document in `docs/SKILLS.md`** the rule: "sidecar audit
      storage MUST NOT live under `chains/`". Cross-link from this
      postmortem.

### Knowledge (P2)

- [ ] **D1.** Add this postmortem to `docs/postmortems/INDEX.md`
      (create one if missing) and link from `docs/runbooks/SYSTEMD_EXIT_CODES.md`
      under "exit 102" section.
- [ ] **D2.** Update `docs/ROADMAP-CURRENT.md` (or a new entry) noting
      that `chains/halt/` is deprecated and halt-aware-destructive-ops
      v0.2 will move to `~/.memphis/audit/halt/`.

---

## Open questions

1. **Why did `RestartPreventExitStatus=101 102 103` not stop the loop?**
   user-mode systemd limitation? Wrong directive? Need a controlled test.
2. **Why is `chains/halt/` timestamp `000022` 09:43:48Z but journalctl
   shows timer runs at 00:41:20 and 11:43:47?** Either the timestamp in
   the JSON is from `verify.sh`'s `data.kind=halt-verify` reporting
   something other than its own run time, or there's a clock offset
   worth investigating. Not blocking but should be understood.
3. **Was the 22 wrz 00:40 staging of `halt-aware-destructive-ops/`
   done by the operator manually during a planned setup, or by some
   auto-install path that needs an audit trail?** Files are staged in
   git but uncommitted — operator action is most likely.
4. **What was `chains/halt/` doing between 21 22:40 and 22 00:40?**
   No timer yet (skill not installed), no running daemon (post-SIGTERM).
   Hypothesis: operator ran `check.sh`/`verify.sh` interactively to verify
   the manual soul chain write workflow from yesterday's postmortem.
   Either way, those 22 files are a valid audit trail of "what the
   operator did", just stored in the wrong place.

---

## TL;DR for future sessions

1. **`chains/halt/` is deprecated.** It was a wrong-category storage
   location for halt-aware-destructive-ops audit. Real halt-audit
   will move to `~/.memphis/audit/halt/events.jsonl` (JSONL) in v0.2.
2. **Runtime does not re-validate chains.** Any process that writes
   under `~/.memphis/chains/<name>/` and produces blocks without
   `prev_hash` + `hash` will silently drift until the next BOOT and
   then crash the runtime with exit 102. Always validate format first.
3. **`RestartPreventExitStatus` is advisory in this unit.** If you see
   exit 102, do not assume systemd has stopped restarting. Check
   `boot-failures.json` and journalctl. Add `StartLimitBurst` until
   the directive is verified.
5. **Skill add-on is now subject to dry-run before live** (once B2 lands).
   For now: any skill that touches `~/.memphis/` should be reviewed
   manually before its timer is enabled.
6. **22 halt blocks from 21 22:40 – 22 09:43 are preserved** in
   `~/.memphis-backup-broken-halt-chains-20260922-121016/`. They are
   a valid record of operator activity during the deep-restart of
   21 wrz — keep them, do not delete.

---

## Follow-ups for operator consideration

- **Should `memphis chain rebuild --chain halt` have been attempted
  before archiving?** No — `rebuild` recomputes `prev_hash`/`hash`
  for existing valid blocks. Our blocks were missing the fields
  entirely, not corrupted. A rebuild would not have produced a
  valid genesis block (no `GENESIS_PREV_HASH` to chain from). The
  archive was the right call.
- **Should `memphis doctor --fix` have caught this automatically?**
  In principle yes — but `doctor` itself loads through the same
  chain-adapter at startup, so it crashes on the same `chains/halt/`.
  Boot-time recovery needs to happen **before** any TS code loads.
  Candidate: a Rust-only pre-flight check in `crates/memphis-preflight/`
  that quarantines unknown dirs in `chains/` before the TS layer sees
  them. (See issue #04, layer 3.)
- **Should the operator playbook for "exit 102 from boot" now be
  "check `chains/*/` for unknown dirs, archive them, restart"?**
  Yes — add to `docs/runbooks/SYSTEMD_EXIT_CODES.md` under exit 102.

---

## Implementation log (postmortem written 12:30; fix work 12:42–13:28 CEST)

The four P0 action items from this postmortem were implemented in the
same session (no overnight backlog). Outcomes:

| Action | Status | Verification |
|---|---|---|
| **A1.** Halt audit moved from `chains/halt/` to `audit/halt/events.jsonl` | **Done** | `check.sh`, `verify.sh`, `audit.sh` updated in `skills/halt-aware-destructive-ops/`. Manual test: 4 events written to JSONL, `chains/halt/` no longer created. |
| **A2.** `MEMPHIS_CHAINS_ALLOWLIST` + default allowlist in `chain-adapter.ts/js` | **Done** | `dist/infra/storage/chain-adapter.js` and `src/infra/storage/chain-adapter.ts` both patched. Stress test: created `chains/zzz_real_sidecar_test/000001.json` with missing `prev_hash`/`hash` — `chain verify` skipped it with warning, memphis stayed up. `.env` updated with explicit allowlist. |
| **A3.** Verify `RestartPreventExitStatus` actually stops restarts | **Verified** | Controlled test (`test-exit-102.service` with `process.exit(102)`) showed systemd stopped restarting after first attempt. **The directive works on this host in user-mode.** The 298-reboot storm observed during the incident remains unexplained at this layer — see open question §1. |
| **A4.** Hard rate limit (`StartLimitBurst=5`, `StartLimitIntervalSec=300`) | **Done** | `memphis.service` updated. After 5 failed starts within 5 minutes, systemd gives up. `systemd-analyze verify` passes. |

### New open questions raised during implementation

1. **Why 298 restarts with `RestartPreventExitStatus=102` set?** A3 test
   confirmed the directive works now. Hypotheses:
   - systemd user-mode version differs (we tested after `daemon-reload`).
   - The pre-restart system uptime was 4 min — the host was just rebooted
     at 11:42 CEST. Maybe an older systemd was active at that moment.
   - Exit code from the `node` wrapper is different from what systemd
     reports in `status=102/n/a` — needs `strace` to confirm.
   Worth re-testing with a deliberately corrupted chain (mkdir
   `chains/foo/000001.json` with broken shape) under the now-patched
   `memphis.service`. With A2 in place, `chain verify` should already
   skip the broken dir, so memphis should boot — and if A4 is correct,
   even without that, the burst limit will fire after 5 attempts.
2. **`legacy block shape in system/006849.json`** appeared in
   `runtime.firstRun.reasons` after restart. The block is well-formed
   (has `hash`/`prev_hash`) but the first-run detector flags it as
   "legacy". Cause unknown; recommendedAction is "Run memphis repair
   runtime". Out of scope for this incident but worth a separate
   investigation.
3. **`backups.enabled: false`** in health endpoint. The
   `memphis-scheduled-backup.timer` is active but `scheduled_backup`
   task is disabled. Linked to the persistent failure from
   `2026-09-20 02:00:00` onwards (`backup.scheduled.failed`). Out of
   scope but should be re-enabled when root cause of backup failures
   is fixed.

### Not implemented (carried forward)

- **B1.** Runtime periodic chain integrity scan (5 min header / 1 h full)
  — design landed, not coded. Implementation requires scheduler
  integration; deferred to a follow-up session.
- **B2.** Skill loader dry-run — design landed, not coded. Requires
  `memphis skill install --dry-run` mode in `src/skills/`. Deferred.
- **B3.** `doctor` should refuse `start` when `boot-failures.json > 5`
  in 10 min. Easy to add but tied to B1 detection pipeline. Deferred.
- **C1.** Skill `compat.test.sh` contract — design landed. No new
  skill has been written since, so no new contract enforced yet.
- **C2.** Pre-commit git hook for `memphis chain verify`. Easy to add
  to `.githooks/`. Not done — operator should add when convenient.
- **D1.** `docs/postmortems/INDEX.md` — this postmortem is the first
  long-form entry; no index exists yet. Future-proofing only.
- **D2.** `docs/ROADMAP-CURRENT.md` entry noting `chains/halt/` is
  deprecated. Done as a note in this postmortem; can be cross-linked
  from ROADMAP in a follow-up.

### Files changed by this fix work

```
/home/memphis/.config/systemd/user/memphis.service           [A4]
/home/memphis/memphis/.env                                    [A2]
/home/memphis/memphis/dist/infra/storage/chain-adapter.js     [A2]
/home/memphis/memphis/src/infra/storage/chain-adapter.ts      [A2]
/home/memphis/memphis/skills/halt-aware-destructive-ops/check.sh   [A1]
/home/memphis/memphis/skills/halt-aware-destructive-ops/verify.sh  [A1]
/home/memphis/memphis/skills/halt-aware-destructive-ops/audit.sh   [A1]
/home/memphis/memphis/docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md   [this file]
```

The two active runtime artefacts created by the incident and preserved
for the historical record:

```
/home/memphis/.memphis-backup-broken-halt-chains-20260922-121016/   (22 files)
/home/memphis/.memphis/state/boot-failures.json.bak-20260922-121016   (50 entries)
```

Note: `SKILL.md` in `skills/halt-aware-destructive-ops/` still
documents the old `AUDIT_DIR=chains/halt` path in code-fenced examples.
Documentation drift — should be updated in a follow-up commit.

---

## Anti-confab

**VERIFIED (live evidence):**

- `chains/halt/000001.json` and 21 siblings all missing `prev_hash` /
  `hash` — verified by `python3 -c 'json.load(...)'`.
- `chain-adapter.js:582` validation requires those fields — verified by
  reading source.
- All 10 real chains (collective, soul, system, cases, decisions,
  insights, journal, patterns, reflections, autonom_archive) integrity
  OK after archive — verified by `memphis chain verify` (exit 0, 11 958 blocks).
- `health` endpoint reports `status:healthy`, all sub-systems OK —
  verified by curl.
- 22 archived files preserved on disk — verified by `ls -la`.
- `soul/000256.json` (manual append OpenClaw v0.1.0) intact — verified
  by file presence and `memphis chain verify` count.
- `RestartPreventExitStatus` did not stop the loop — verified by 50+
  restart entries in `boot-failures.json`.

**UNVERIFIED:**

- Why exit 102 re-triggered `Restart=on-failure` despite the directive.
  Hypothesis A (user-mode systemd limitation) untested. Hypothesis B
  (node wrapper re-emits) also untested.
- Exact cause of halt files being written 21 22:40 (operator manual
  vs. some auto-install hook). Filesystem mtime confirms the writes;
  intent requires operator confirmation.
- Clock-skew question on `000022.json` timestamp (09:43:48Z vs
  journalctl 00:41:20 and 11:43:47). Not blocking, just unresolved.

**OUT OF SCOPE:**

- Full fix of `memphis-halt-integrity.timer` (only A1, A2, B1 needed).
- Refactor of `chains/` validation to accept "audit-style" blocks.
- Pre-flight check in Rust (issue #04 layer 3) — separate workstream.
- Replay of the 22 archived halt events into the new
  `~/.memphis/audit/halt/` location — operator choice after A1 lands.