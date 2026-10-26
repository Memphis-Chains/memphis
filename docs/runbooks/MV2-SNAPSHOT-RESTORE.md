# Signed MV2 snapshots

MV2 export preserves original block hashes, optional signatures, and all JSON
payload fields. Block frames carry JSON strings (`json-string-v1`) so the
native JSON parser cannot round floating-point values before signature checks.
The native v0 container checksum detects damaged bytes; an
Ed25519 signed manifest binds the complete payload, chain selection, counts and
exporting DID. The vault and embedding tracks are refused. A snapshot is not
encrypted: keep it private (the exporter creates it with mode 0600).

```sh
memphis export --format=mv2 --output /private/quarter.mv2 \
  --include journal,decisions,reflections,cases,patterns,system --json
memphis import --from-mv2 /private/quarter.mv2 --into /private/restored \
  --trusted-signer did:key:ed25519:EXPECTED_PUBLIC_KEY --dry-run --json
memphis import --from-mv2 /private/quarter.mv2 --into /private/restored \
  --trusted-signer did:key:ed25519:EXPECTED_PUBLIC_KEY --write --confirm-write --json
```

Export signs using the existing `did_seed` through the vault boundary. Recover a
missing public DID before exporting; do not initialize a replacement identity.
Import accepts the current runtime's public DID by default. For another author,
obtain the expected public DID independently and pass `--trusted-signer`.
A container's self-declared signer is never automatically trusted.

Both import modes validate the native checksum, signed manifest, frame identities,
counts, block hashes, optional block signatures and each chain's complete index /
previous-hash sequence. Dry-run also checks destination eligibility and creates
nothing. Input and output are limited to 128 MiB. No vault entries or seeds are
restored, and live chains are never merged or rewritten.

The destination parent must exist. The destination must be absent and separate
from the active runtime, including its ancestors and descendants. Existing paths
and dangling symlinks are refused. Real import writes a private sibling staging
root using canonical block-storage APIs, rereads and compares every block, then
publishes the root with a directory rename. Cooperating imports serialize on an
exclusive sibling `.mv2-import.lock`; a stale lock requires operator review.
Failure can retain private staging data for investigation. The rename uses the
host filesystem's directory semantics; the parent must be operator-controlled,
not shared with unrelated writers. It is not a cross-chain transaction: source
chains are captured one at a time under their writer locks.

Soul-chain restoration requires its dedicated privileged workflow and is refused
by this generic importer. Default export (`journal,chains`) includes all catalog
chains, including soul; select the six chains above for a generic restore.
Legacy unsigned MV2 exports lack the manifest and cannot be imported as trusted
snapshots. Re-export from the original verified source instead of bypassing
verification. This scope does not complete every historical “all tracks” roadmap
item: vault/embedding transfer and privileged soul restoration remain separate.
