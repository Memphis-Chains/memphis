# PR-NOTES-VAULT-PHASE1.md

Real-deal.

## Scope
Vault Phase 1 runtime hardening + verification path.

## What changed
- Added runtime HTTP E2E script: `scripts/vault-runtime-e2e.sh`
  - Validates path: `init -> encrypt -> decrypt -> entries`.
  - Asserts `fingerprint` and `integrityOk` on persisted entries.
  - Uses isolated temporary mock Rust bridge to keep runtime check deterministic.
- Updated docs:
  - `docs/VAULT-API.md` with verification commands.
  - `docs/V0.2.0-RC-CHECKLIST.md` with runtime E2E gate.

## Migration behavior (must-know)
Decrypt path remains backward compatible:
1. `mv1:<base64-ciphertext>` (current format)
2. `<base64-ciphertext>` (legacy no-prefix)
3. `plain:<plaintext>` (legacy scaffold fallback)

## Runtime policy
- `MEMPHIS_VAULT_PEPPER` is required for runtime vault calls (>=12 chars).
- Without valid pepper or available bridge, vault runtime calls fail safely (`503`).

## Why this is safe
- Small, isolated change-set (script + docs).
- No changes to production routing logic.
- Existing full smoke and quality gates remain green.
