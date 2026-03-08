# PHASE1.9-HARDENING.md

Real-deal.

## Objective
Finalize Phase 1 vault track into a merge-ready, operator-safe batch.

## Hardening outcomes

### Security posture
- Vault runtime bridge requires `MEMPHIS_VAULT_PEPPER` (minimum length policy).
- Vault routes are auth-protected when `MEMPHIS_API_TOKEN` is enabled.
- Ciphertext is versioned (`mv1:`) with migration-safe decrypt path.
- AES-GCM AAD binds ciphertext to normalized key alias.

### Data integrity
- Persisted vault entries include `fingerprint` (SHA-256 over key/encrypted/iv).
- Read path verifies integrity and returns `integrityOk` in `/v1/vault/entries`.

### Reliability
- Rust + TS test suites remain green.
- Vault smoke script available for repeated operator checks.

## Required runtime env (vault-enabled mode)
- `RUST_CHAIN_ENABLED=true`
- `RUST_CHAIN_BRIDGE_PATH=<path-to-bridge>`
- `MEMPHIS_VAULT_PEPPER=<secret>=12+ chars`
- optional `MEMPHIS_VAULT_ENTRIES_PATH=<path>`

## Merge recommendation
Merge entire `feat/phase1-vault-bootstrap` as one batch PR (squash), then run post-merge smoke before any release action.
