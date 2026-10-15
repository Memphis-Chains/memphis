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
