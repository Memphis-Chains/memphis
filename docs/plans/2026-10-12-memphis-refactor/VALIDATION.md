# Memphis refactor validation

This file separates checks actually executed during local repair from future acceptance gates. A proposed command or test is not evidence that it passed. Production data must never be the fixture for vault rotation, destructive restore, migration or failure injection.

## Current checkpoint — 2026-10-18

Legacy init output now has a closed public projection: 69 TS cases passed, one
adapter JS deployed. Local V11 launch-path acceptance passed 51 tests in nine files,
including eight real TS/native process cases and a transient user-systemd service,
with zero skips. The cwd/runtime-root discrepancy was reproduced before fixing it.
One path-bridge JS deployed, native unchanged. Both scopes passed two starts,
doctor 47/13/0, native TUI and exact MiniMax HTTP200 canaries; protected files and
their predeploy index remained unchanged. See E18-INIT-RESULT/E18-LAUNCH-PATHS in
[EXECUTION](EXECUTION.md). These counts overlap earlier regression selections and
must not be added as unique project tests. Full S1/release acceptance remains open.

Later deployed evidence supersedes the open work listed in older dated sections:
H3, HTTP audit, atomic-write diagnostics, shared readers and CLI failures are
implemented and locally deployed; see [execution record](EXECUTION.md).
CLI has 37 passing TS cases; doctor 47/13/0, native TUI passed. MiniMax attempts
500/200/200 are retained with the first failure's cause unconfirmed. Protected
files and immediate predeploy index/native hashes matched through CLI canary.

Native Debug source has ten new regression tests and an isolated offline workspace
run: 475 passed, zero failed, two ignored. Sources and protected files matched;
the index check failed because 50 staged entries changed during testing (author
unknown, preserved). Fresh private NAPI/TUI/example build and typecheck passed; frozen combined S1 TS
acceptance passed 577 tests in 86 files, with source/protected/fresh-index proof.
NAPI/TUI are deployed; two starts healthy, doctor 47/13/0, TUI and exact MiniMax
HTTP200 canary passed. Final source/protected/index and deployed native hashes
matched. Scoped rustfmt passed; full repo formatting and staged whitespace checks
have recorded pre-existing failures outside this change. Full S1 and release acceptance
remain open. Older dated gaps below are historical, not the current task queue.

## E18-STORAGE — partial V02 evidence, 2026-10-18

Eight encrypted publication-failure cases and 18 existing transaction cases passed.
Both rotations recover after simulated partial-write ENOSPC and real unprivileged
EACCES at either target, with two fresh independent decrypting processes per case.
The final new-fixture rerun passed all eight without skips. Protected files/index
unchanged; test-only change, no deployment. See
[scope and durability limits](EXECUTION.md#e18-storage--verified-2026-10-18).
Native I/O failure injection, journal-database ENOSPC and full acceptance remain
unclaimed. A process restart does not establish power-loss durability.

## E18-WALLET / E18-PROSE — 2026-10-18

Sixteen wallet tests passed, including an independently computed signing reference;
four new failures were reproduced before fixing public exceptions/private lengths.
One compiled JS file deployed, two starts/doctor/TUI/MiniMax passed. See
[wallet evidence](EXECUTION.md#e18-wallet--deployed-2026-10-18). H3 and full V03
remain open. No actual financial transaction was used as a test.

S1.8 local triage completed: zero matches for checked active credential candidates
and zero current worktree/index findings after narrowly redacting the historical
AGENTS notice. All other staged entries were preserved. Six historical patch
occurrences remain; remote visibility/current Synjar status are not certified.
See the [sanitized inventory](../../postmortems/2026-10-18-credential-prose-triage.md).
No active credential rotation or history rewrite was performed.

## E18-AUDIT partial acceptance — 2026-10-18

119 distinct TS cases in 19 files and one Rust Debug sentinel passed; see
[execution evidence](EXECUTION.md#e18-audit--deployed-2026-10-18) for rerun limits.
Fixed audit/error projections, URL/unknown-field redaction, hook failures and
initialized-vault pepper reload veto are deployed. Two starts, doctor 47/13/0,
TUI and exact MiniMax canary passed; protected files and predeploy index unchanged.
These are partial V01/V03 checks. Wallet/H3 public outputs, prose/history triage,
the complete transport matrix and full S1/release acceptance remain open.

## E18-ALIASES acceptance — 2026-10-18

S1.6 is locally deployed. The shared four-provider fixture verifies default/custom
references, whitespace, replacement/removal, corrupt newest entries and intentional
plaintext configuration. Native rejects implicit fallback; missing Anthropic
credentials report unconfigured. 43 TS and ten Rust selector tests passed.
Two starts, doctor 47/13/0, native TUI and real MiniMax remote generation passed;
protected hashes and immediate predeploy index stayed unchanged. See
[execution evidence](EXECUTION.md#e18-aliases--deployed-2026-10-18). This closes the
alias portion of V04, not the complete S1 or release acceptance matrix.

## E18-CACHE acceptance — 2026-10-18

S1.5 and the metadata recovery subcase of S1.4 are locally deployed. See
[execution evidence](EXECUTION.md#e18-cache--deployed-2026-10-18): 99 distinct TS
and 187 distinct Rust tests passed, with one BASAL-dependent case ignored.
State/entry replacement, explicit invalidation, accepted/no-op/rejected/dry-run
reloads, two warm TS/native readers after external pepper rotation, fresh config
load, native entry replacement/removal without another KDF, pending metadata
publication and rotation/writer races are covered. One timeout in the 69-test
surface run passed on isolated retry; overlapping reruns are not added to totals.

Two starts, health, required doctor checks, native TUI and a real MiniMax
remote-generation canary passed. Doctor: 46 pass, 14 warn, zero failures; the
extra warning versus October 17 is optional GLM connectivity. Protected files
and the index immediately before deployment stayed unchanged. This closes the
cache subcases of V04, not custom-alias parity, V01–V04/V11 as whole gates, full
restore, isolated Omarchy acceptance or the release observation window.

## Earlier acceptance status — 2026-10-17

The evidence identifiers below resolve in [EXECUTION.md](EXECUTION.md). Task
checkboxes and successful targeted suites do not imply that an entire V-row has
passed. The matrix further below remains the required contract.

| Gate    | Evidence already available                                                                                                                           | Still required for acceptance                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V01     | E16-CONFIG: initialized-vault pepper set/unset guard under shared locks; runtime generation lifecycle fixtures.                                      | Reconcile every supported config surface against the same fixture, including rejected changes and same/fresh-process state.                                                                                      |
| V02     | E15-ROTATION / E15-CONCURRENCY: prepared and each published-file SIGKILL point, both rotations, journal migration, reader/writer/init serialization. | Disk-full and permission failure injection on isolated storage; declare the exact durability boundary. Process-kill coverage is not host power-loss coverage.                                                    |
| V03     | E17-READERS / E17-SNAPSHOT: sanitized state/entry errors, audit-field filtering and malformed-input sentinels.                                       | Complete transport/diagnostic sentinel matrix, nested and async failures, headers and allowed destination assertions. A trusted callback may return its input; verify secrecy at the public diagnostic boundary. |
| V04     | Shared Rust readers and two-process master-key rotation reads; existing pepper collision and custom alias fixtures.                                  | Explicit config-generation cache invalidation, long-lived external pepper rotation, replacement/removal and final TS/native alias parity at one source revision.                                                 |
| V05     | Existing native tier/catalog policy changes and prior narrow tests.                                                                                  | Complete manifest, principal/session grants, expiry/revocation/restart and every executor.                                                                                                                       |
| V06–V07 | Existing provider diagnostic implementation and targeted tests.                                                                                      | Full safe DTO, freshness, cancellation, redirect, failure-code and quota matrix across declared surfaces.                                                                                                        |
| V08–V09 | Existing archive/SQLite content drills and scheduler persistence changes; local recovery material.                                                   | Complete isolated restore including WAL, credential and matching DID; exact schedule occurrence, restart/failure and retention cases.                                                                            |
| V10     | Live health/doctor/TUI checks and partial scheduler/recovery diagnostic contracts.                                                                   | One populated fixture through every diagnostic surface, canonical metadata, optional integrations and absence of hidden paid probes.                                                                             |
| V11     | E16-CONFIG: absolute path snapshots, launchers, bootstrap/reload and native config fixtures.                                                         | Home, Work, unrelated project, clean env and isolated service matrix; agree on persisted data identity and provenance, with explicit process-local generation semantics.                                         |
| V12–V13 | Existing native context/TUI work; historical single PTY cycle.                                                                                       | Sanitized token baseline and continuity/cancellation fixture; ten complete PTY resize/stream/failure/exit cycles.                                                                                                |
| V14     | Existing chain locks, metadata/index and concurrency work in the mixed tree.                                                                         | Review and run the full concurrent/kill/rebuild/multilingual fixture against the selected implementation.                                                                                                        |
| V15     | Local Omarchy integration and controlled service restarts.                                                                                           | Isolated clean install, repeat install, upgrade, rollback, reboot/login and uninstall with retained data and unrelated agents.                                                                                   |

Latest local verification is E17-SNAPSHOT: 76 distinct TS tests in nine files,
TS typecheck/build and changed-file lint/format pass; two service starts; doctor
47 pass / 13 warn / 0 fail / 0 required failures; native TUI passes; MiniMax
HTTP 200 with the expected marker. Protected env, vault and DID hashes remained
unchanged. This is one local verification sequence, not a full-suite run,
full restore, isolated-host acceptance or a completed release canary window.

No new runtime tests are attributed to the planning reconciliation. Private logs
and artifact identities are linked from EXECUTION; previous suite counts overlap
and must not be added together as a count of unique coverage.

## Historical local checks — 2026-10-12

| Check                     | Result and scope                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault recovery            | Current pepper failed authenticated state decryption; two existing env backups succeeded against the same state and MiniMax entry. Matching pepper restored without resetting state.                                                |
| Service startup/restart   | `systemctl --user` reports active/running and enabled; linger=yes; automatic restart count was 0 after the controlled restart.                                                                                                      |
| Service definition        | `systemd-analyze --user verify` passed with the new local drop-in. Node major-version alias and normal CLI boot entrypoint are active.                                                                                              |
| HTTP health               | `/health` returned healthy; chain integrity reported no invalid blocks. Counts are point-in-time and can grow with normal work.                                                                                                     |
| MiniMax generation        | Authenticated local `/v1/chat/generate`, `mode=provider-only`, configured MiniMax-M3.1-Flash-Preview: HTTP 200, output `MEMPHIS_OK`, 855 ms, 212 input tokens and 6 output tokens. One successful request, not an availability SLO. |
| Native TUI preflight      | `memphis tui --check-only --json` returned `ok=true`, no snapshot errors, correct vault/data/database paths.                                                                                                                        |
| Interactive launcher      | `omarchy agent --inline` in a 120×40 PTY rendered the TUI and exited with Ctrl-C, code 0; no unsupported-agent or decrypt error observed. One cycle, not the future ten-cycle gate.                                                 |
| Shell argument handling   | Isolated HOME/stub tests preserved multiword prompts and literal shell metacharacters; inline/default-agent install routing passed.                                                                                                 |
| Desktop integration       | Menu JSONC parsed, desktop entry validated, `hyprctl reload` succeeded and `hyprctl configerrors` was empty. Restarted shell inherited the intended PATH.                                                                           |
| Required doctor checks    | After supported DID initialization: exit 0; 60 total, 46 pass, 14 warn, 0 fail, 0 required failures.                                                                                                                                |
| Identity                  | New public DID written; encrypted `did_seed` added; `rotated=false`. Existing MiniMax entry retained.                                                                                                                               |
| Native tier generator     | `npm run -s ops:sync-native-tiers -- --check` reported up to date. This establishes table consistency, not complete authorization parity.                                                                                           |
| Existing scheduled backup | The enabled 02:00 Europe/Warsaw job had one successful run. Archive checksum/list verification passed. Existing `drill=pass` is only the limited current drill described in AUDIT.                                                  |
| Post-repair archive       | `omarchy-repair-2026-10-12-12-22.tar.gz`: 174 files; archive/checksum validation passed.                                                                                                                                            |
| Private recovery set      | Matching repaired env, two-entry vault, public identity and operator config copied under mode 0700 directory with files 0600. Both SQLite backup snapshots passed `PRAGMA integrity_check`; both copied vault entries decrypted.    |

Full host reboot, GUI clicking of every menu entry, clean-machine installation, restored-host boot, ten-cycle TUI testing, all TS/Rust suites and the S1–S9 refactor were not performed by these checks. The repair does not require claiming any of those results.

## Acceptance matrix for implementation

| ID  | Scenario and fixture                                                                                             | Required assertions                                                                                                                                                                   | Sprint |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V01 | Existing v2 vault; change pepper through every config surface                                                    | Generic write refuses; no file or in-memory generation divergence; fresh-process reads still work                                                                                     | S1     |
| V02 | Kill at every rotation transaction step; disk-full and permission failures                                       | Startup recovers old or new consistent pair; all entries preserved; no fresh master key; no secret logs                                                                               | S1     |
| V03 | Synthetic sentinel secret in success, callback return, nested exception, HTTP error and audit payload            | No sentinel or derived fragments in model-visible outputs, logs, snapshots or exported diagnostics; allowed connector receives it only at configured endpoint                         | S1, S3 |
| V04 | Custom credential alias, replaced entry, same-length changed pepper, changed state and mixed native/TS processes | Same selected entry/state/error on all paths; old cache cannot authenticate a new generation                                                                                          | S1, S3 |
| V05 | Known/unknown tool; tier limits; expired/revoked grant; two users and two surfaces                               | Every executor enforces explicit policy; no cross-session authorization; unclassified manifest entry fails generation/CI                                                              | S2     |
| V06 | Unset credential, valid local secret, invalid local state, expired cached probe                                  | Diagnostic names the actual verification level; local check performs no provider request; stale evidence is marked                                                                    | S3     |
| V07 | Local stub server simulating 200/401/403/429/500, slow stream, disconnect and redirect                           | Correct typed errors, bounded retries/cost, cancellation, no cross-origin credential forwarding, correct quota accounting                                                             | S3     |
| V08 | Complete synthetic recovery set with pending SQLite WAL and vault identity                                       | Isolated restore recovers expected rows/blocks, decrypts fixture secret, validates identity and never alters live source                                                              | S4     |
| V09 | Backup cron due during restart; failure; invalid task status; retention across tags                              | One execution per scheduled occurrence; persisted status/freshness; valid state transitions; last verified recovery set retained                                                      | S4     |
| V10 | Same populated fixture through health/doctor/readiness/native snapshot                                           | Same authoritative state; optional integrations reported optional; recovery read from stored config; no paid probe hidden in health                                                   | S5     |
| V11 | Home, Work, arbitrary project, systemd and clean environment                                                     | Same canonical paths and committed data identity; process-local epochs are explicit; no incidental `./data` creation outside selected runtime; inherited overrides handled explicitly | S1, S7 |
| V12 | Sanitized long conversation with pending tools, operator correction and restart                                  | Context attribution available; goal/constraints/evidence preserved; no incomplete tool pair; no duplicated destructive action; compare token use to baseline                          | S6     |
| V13 | PTY start, resize, Unicode, stream, cancel, worker failure and exit                                              | Terminal restored, useful error shown, no orphan worker or crash across ten repetitions                                                                                               | S6     |
| V14 | Concurrent writers; kill during append/index flush; long Polish record; corrupt derived index                    | Valid chain sequence/hashes, no lost committed records, rebuildable projections, expected retrieval and stable parent references                                                      | S7     |
| V15 | Isolated Omarchy clean install, repeated install, upgrade, rollback, reboot and uninstall                        | All launch surfaces agree; other agents unaffected; package files untouched; data retained; update either starts healthy or rolls back clearly                                        | S8, S9 |

Use unique synthetic credential markers per case. Sanitization tests inspect values, nested JSON, headers, errors and logs; a regex over field names alone is inadequate. Never paste real credentials into test code, arguments, reports or a chat prompt.

## Existing test assets to extend

- Vault: `tests/unit/vault-boundary.test.ts`, `vault-pepper-rotate.test.ts`, `vault-double-init-guard.test.ts`, `vault-paths.test.ts`, and `tests/regression/vault-cache-collision.test.ts`.
- Auth: `tests/security/operator-gate.test.ts`, `tests/unit/cli-auth-audit.test.ts`, `tier3-session.test.ts`, registry tests and native tool-tier cases in `chat.rs`.
- Providers/config: `tests/integration/vault-provider-key.e2e.test.ts`, `tests/unit/config-hot-reload.test.ts`, provider tests in native `provider.rs`.
- Setup/diagnostics: `tests/unit/service.command.test.ts`, `doctor.fresh-install.test.ts`, `doctor.cron-tasks.test.ts`, `rust-tui-launcher.test.ts`, `http.health.test.ts`.
- Backup/memory: `tests/unit/cli.backup.test.ts`, backup integration fixtures and `tests/integration/chain-format-compat.test.ts` when chain adapter behavior changes.

Additional acceptance fixtures implied by V01–V15 are planned; their existence is not asserted here. Before running existing tests, inspect their isolation and inject temporary runtime roots, vault paths, databases and audit paths. Do not rely on cwd or automatic dotenv loading to isolate them.

## Commands and evidence capture

Read-only/local status commands useful on this installation:

```bash
systemctl --user status memphis.service --no-pager
curl --fail --silent http://127.0.0.1:3000/health
memphis doctor --json
memphis tui --check-only --json
memphis backup list --verify --json
npm run -s ops:sync-native-tiers -- --check
```

Run the last command from the repo. Native TUI `--check-only` currently emits a non-TTY warning when redirected even though the preflight succeeds; distinguish that presentation issue from an actual interactive launch failure. Generic doctor checks may inspect configured external services; do not label the whole doctor command offline.

For each implementation PR, record commit, build artifact/native bridge version, fixture ID, command, environment scope, exit code and short assertion summary. Keep reports free of complete env dumps, live conversations and secrets. Evidence references must remain valid after rebasing or be regenerated.

## Release gates

1. Required checks pass on supported clean and upgrade fixtures; affected TS/Rust tests, type checks, lint and formatting run against the same source revision.
2. Manifest, native tiers and transport schemas agree. Unknown operations fail closed; intended public operations remain explicitly classified.
3. Existing vault/chain data remains readable. Failure-injected migration and complete isolated restore pass before rollout.
4. A real configured-provider canary is recorded with its exact verification level. Offline CI uses synthetic stub servers; a cached health result cannot substitute for the canary.
5. Omarchy launch/reboot/upgrade acceptance passes on an isolated host. Current local checks alone are insufficient for a distribution claim.
6. The canary runs through at least one scheduled backup and one restart with observable, persistent evidence. Optional features and skipped checks are named.
7. Migration instructions, data compatibility, protected backup coverage and rollback artifacts are reviewable before publishing.
