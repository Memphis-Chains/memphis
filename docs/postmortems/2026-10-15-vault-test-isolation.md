# Vault recovery and test isolation — 2026-10-15

## TL;DR

The October 14 startup failure came from an incompatible vault state and pepper.
Both existing encrypted entries and the DID were preserved. Recovery restored
only the matching historical state and pepper after verifying decryption and
that the recovered seed derives the existing public identity.

## Root cause and evidence

The runtime dotenv differed from the known-good recovery dotenv only in its
vault pepper. The replacement matched the synthetic value used by the backup
restore validation test. The damaged vault state decrypted using another test
fixture pepper. The exact historical writer of that state is not established.
The existing encrypted entries and DID matched the good recovery set byte for
byte. Backup restore tests did not pin their dotenv destination; CLI vault tests
also lacked explicit state and dotenv paths. These paths could escape temporary
fixtures through configuration loaded from the real installation.

## Resolution

- Preserved the worktree, index, configuration, data and consistent SQLite snapshots
  under `/home/memphis/.memphis-backup-recovery-20261014-6dvzrbul` (private).
- Restored matching state and pepper from the October 12 recovery set, without
  resetting the vault, changing entries or replacing databases.
- Added per-file Vitest configuration/storage isolation and explicit CLI fixture
  paths; added a subprocess regression against synthetic operator sentinels.
- Extended key cleanup to encryption failures during master-key rotation and
  replaced remaining direct state writes with the existing atomic private writer.
- Preserved typed launcher exit codes 101–103 so systemd restart prevention works.

## Verification and limits

Initial recovery: API healthy, real MiniMax response, native TUI preflight and
Doctor passed (47 pass, 13 warnings, zero failures). Rust workspace tests passed:
444 passed, two ignored. Final deployment results are recorded in the recovery
handoff. No machine reboot or complete S1–S9 acceptance is implied.

## Follow-ups

Review and commit the mixed pre-existing work by topic; complete S1 transaction
failure/recovery gates before proceeding through the remaining refactor plan.
The historical recovery manifest references transient SQLite WAL/SHM files that
are absent; persistent files used for recovery were verified individually.
