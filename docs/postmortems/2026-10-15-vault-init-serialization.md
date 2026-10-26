# Concurrent vault initialization — 2026-10-15

## Problem and evidence

`vaultInit` checked for existing state before generating and publishing a new
master key, without acquiring the journal lock used by rotation and credential
writers. Two initializers could both observe an absent state and report success
with different keys. A process regression reproduced this for both the explicit
dotenv journal and the legacy state-path journal: both competing-init cases
failed before the fix because the second initializer succeeded.

The existing state guard also treated malformed JSON and read failures as an
absent vault. The lower-level adapter did not check orphaned entries; only the
security boundary checked for entries, using a permissive listing operation.

## Change

Initialization now holds the shared journal writer lock across pending recovery,
state/entries checks, key generation and atomic state publication. The guard
rejects nonempty or unreadable state and nonempty or malformed entries. Missing
files, an empty state file and an empty entries array remain valid fresh-install
inputs. The explicit force flag retains its prior bypass but cannot bypass the
lock. The in-memory vault is assigned only after successful publication.

New tests pause real Rust/NAPI initialization before rename, start a competing
initializer and verify refusal plus decryption from a fresh process. Another
test kills the first initializer before publication and verifies that a new
process can initialize and decrypt successfully. Unit cases preserve malformed
and orphaned data byte for byte.

Adding the entries guard exposed incomplete explicit environments in adapter
and migration unit fixtures: they pinned state but omitted entries. Those
fixtures now pin both paths. The first regression run read the live entries
path and refused initialization; it did not mutate those entries. Live env,
vault and DID hashes were compared privately with the prior deployment and
were unchanged.

## Scope and rollback

This is one S1 lifecycle correction, not full S1 acceptance. Cooperating callers
must use the same journal path. Unified configuration provenance and journal
selection across standalone TS/native launches remain separate work. External
editors and power-loss durability are outside this process-level test contract.

No live vault initialization or key rotation is performed for validation.
Rollback restores the previous build; there is no new storage schema. Keep
pending transaction journals and encrypted state intact.

The private starting index/worktree snapshots and validation logs are under
`/home/memphis/.memphis-backup-vault-init-dwh11_25`.

## Verification

The focused strict Vitest run passed 114 tests in 19 files, including the new
initialization races, rotation SIGKILL cases, concurrent credential writers,
native snapshot reads, CLI guards and isolation regression. Type checking,
changed-code formatting and the staged TypeScript build passed. Rust source and
native binaries were unchanged; this slice did not rerun the full Rust suite.
