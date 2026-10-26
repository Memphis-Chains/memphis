# Recover the public DID

`memphis identity recover --json` derives the public Ed25519 identity from the
existing `did_seed` vault entry. It never generates or stores a private seed.
The seed is consumed through the audited vault boundary in memory; the public
file is published privately and exclusively at `<dataDir>/did.json`.

The command is idempotent for a matching public file. It refuses malformed
public files, a public/private identity mismatch, missing or unreadable seeds,
and publication collisions. `--force` does not override these refusals.
Preserve conflicting files and investigate their provenance before changing
an identity; replacing a signing key invalidates existing signatures.

When the public file is absent but a seed exists, `identity init` refuses with
`recovery-required` and points to recovery. Fresh initialization remains an
explicit operation for a new identity. Existing explicit rotation behavior is
unchanged and is not part of recovery.

The public file's `createdAt` records its publication time. Recovery does not
claim that this is the original private key creation date. Operator vault
state, entries, pepper and master key are unchanged by the recovery operation.
