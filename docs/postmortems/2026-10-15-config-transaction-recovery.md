# Configuration transaction recovery — 2026-10-15

## Problem and change

Recovery checked and published each target in order. A conflict in a later target
could therefore be discovered only after another target had already been
republished. Recovery now validates every target before any publication. Invalid
payloads and duplicate lexical path aliases are rejected before preparing intent.

The private SQLite journal persists intent before atomic file publication. On
interruption, recovery rolls forward to the prepared generation; it does not
promise rollback to the previous generation. Repeating recovery is idempotent.
Unrelated edits stop recovery for inspection rather than being overwritten.
The lock coordinates writers using this journal; external editors do not acquire
it, so checking hashes is not a general filesystem isolation guarantee.

## Verification

Eleven journal tests cover exceptions after both target publications, real process
exit, SIGKILL after each publication followed by a fresh recovery process,
prepared intent before the first publication, idempotence, private permissions,
stale writers, lexical aliases and conflicts in later targets. Adjacent tests
cover configuration guards, key rotation, pepper rewrapping and fixture isolation.
All fixtures use temporary paths and synthetic content. These journal crash tests
check file-generation recovery; they do not by themselves establish end-to-end
credential decryption across every crash point in the production rotation command.

## Scope and remaining gates

This is the journal foundation of S1.3, not acceptance of the whole S1 sprint.
Remaining gates include crash tests through the actual rotation entrypoints with
encrypted credentials, config provenance/generation across native and TS readers,
concurrent lifecycle operations, cache/alias parity and audit serialization.
No active pepper or key was rotated for this change.

## Rollback

Before reverting readers, finish any prepared transaction using a compatible
recovery implementation and verify the complete generation. Retain the private
journal and encrypted snapshots; do not delete pending intent or mix individual
files from old and new generations. The on-disk journal schema is unchanged.


## Encrypted rotation integration — subsequent verification

`tests/integration/vault-rotation-crash.test.ts` now drives the actual pepper and
master-key rotation operations using the real Rust/NAPI encryption bridge and
synthetic credentials. Six cases inject SIGKILL immediately before the first
target rename (after durable intent) and after each of the two target renames.
A fresh process loads configuration through the normal startup loader, recovers,
checks both entry fingerprints and decrypts both credentials, including Unicode.
A second fresh startup verifies idempotence. Pepper rotation preserves encrypted
entry bytes; master-key rotation replaces them. The startup fixture also models
systemd inheriting the pre-recovery pepper from EnvironmentFile. Captured output
is checked for the synthetic plaintext sentinels.

The kill injection exists only in a child-process fixture by intercepting Node's
rename syscall wrapper; production crypto and transaction code are not mocked.
This verifies process crashes, not sudden host power loss or filesystem hardware
failure. No live credential is rotated. Generic concurrent credential writers,
full native/TS configuration provenance and all S1 acceptance still need review.


## Concurrent credential writers — subsequent verification

A deterministic two-process regression reproduced an accepted stale ciphertext:
a writer encrypted an entry, another process rotated the master key, then the
first writer appended its old ciphertext successfully. That success left an
unreadable entry. The regression now requires rejection without changing the
entries file, followed by successful fresh encryption in the original process.
This exercises cache invalidation as well as publication safety.

Entry append and delete now acquire the same configured SQLite journal lock as
rotation. Before appending to an initialized vault, the entry must decrypt under
the current state while that lock is held. Publication uses the private atomic
writer. Unreadable existing JSON is rejected on mutation instead of becoming an
empty list that could overwrite existing credentials. Recovery reads inside a
synchronous writer callback reuse its ownership; nested write transactions are
rejected, and callback failure clears ownership.

The concurrent fixture starts three independent native-encryption writers and
checks all twelve added entries plus the two originals from a fresh process.
Writers must share the configured journal path. External file editors, mixed
runtime-root configurations, concurrent initialization and native reader snapshot
consistency are not covered by this lock contract. A rejected stale write must
be retried from encryption, not by resubmitting the old encrypted entry; a stale
pepper configuration requires reloading configuration first.


## Native snapshot coordination — subsequent verification

Rust previously read state and entries separately without participating in the
configuration journal. A cross-language fixture reproduced a generic decryption
failure after a TS writer died between publishing those files. Native secret
reads, provider credential reads (including cached vault handles), and vault
summaries now hold SQLite BEGIN IMMEDIATE locks across the snapshot. A shared
SQLite read transaction would not suffice: TS entry writers publish files while
holding a reserved writer transaction, before committing database metadata.

For compatibility native locks both the state-path journal used by older TS
callers and the configured dotenv journal; aliases are canonicalized, deduplicated
and acquired in a stable order. The TUI launcher pins the resolved dotenv path.
Direct native launches using a dotenv-backed rotation must provide
MEMPHIS_ENV_FILE (or MEMPHIS_RUNTIME_ROOT); no unrelated working-directory dotenv
is guessed. Initialized vault reads require writable private lock journals.
Absent optional vaults create no journals.

Pending prepared intent is reported as recovery-required before decrypting or
using a cached key. Native does not replay TS journal content itself. Recovery
remains in the configuration/vault loader. Two process integration tests cover a
paused TS publication and SIGKILL followed by TS recovery and a successful native
read. Rust unit tests cover both journal paths, alias deduplication and optional
vault absence. This does not migrate arbitrary native/TS configuration roots or
claim safe concurrent vault initialization.
