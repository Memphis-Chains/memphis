# Rust Chain Signing Rollout

Use this runbook to roll out signed-block enforcement safely.

## Env knobs

- `RUST_CHAIN_REQUIRE_SIGNATURES`:
  - `false` = signatures optional
  - `true` = unsigned blocks are rejected
- `RUST_CHAIN_SIGNER_KEY_HEX`:
  - 32-byte Ed25519 private key in hex (64 chars)
  - when set, Rust bridge auto-signs unsigned blocks before append

Generate a signer key:

```bash
openssl rand -hex 32
```

## Staged rollout

1. Stage A: sign-only shadow mode
   - set `RUST_CHAIN_ENABLED=true`
   - set `RUST_CHAIN_REQUIRE_SIGNATURES=false`
   - set `RUST_CHAIN_SIGNER_KEY_HEX=<hex32>`
   - verify new blocks include `signer` + `signature`
2. Stage B: strict mode in staging
   - set `RUST_CHAIN_REQUIRE_SIGNATURES=true` in staging
   - run `npm run -s ops:rust-core:safety`
   - run API smoke for `/api/journal`, `/api/decide`, `/api/model-d/proposals`
3. Stage C: strict mode in production
   - deploy with `RUST_CHAIN_REQUIRE_SIGNATURES=true`
   - monitor append failures and audit logs for 24h
4. Stage D: enforce continuously
   - keep CI safety gate and branch protection enabled
   - include signing checks in release checklist

## Key rotation policy

1. Generate a new key and distribute through a secret manager.
2. Deploy all writers with new `RUST_CHAIN_SIGNER_KEY_HEX`.
3. Keep old public key in verifier allowlist during transition window.
4. Confirm all new blocks are signed by the new key for at least one release cycle.
5. Remove old key from allowlist and record rotation date in release notes.

## Verification commands

```bash
npm run -s ops:rust-core:safety
RUST_CHAIN_REQUIRE_SIGNATURES=true npm test
```
