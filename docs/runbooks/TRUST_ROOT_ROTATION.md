# Trust-Root Rotation Ceremony Runbook

## Purpose

Rotate trust roots without allowing downgrade or unsigned transitions.

## Preconditions

1. New root keypair generated in controlled environment.
2. Current trusted root key available for transition signing.
3. Rotation metadata prepared:
   - `old_root_id`
   - `new_root_id`
   - `reason`
   - `timestamp`
   - `revoked_keys`

## Procedure

1. Build new `trust_root.json` with incremented `version`.
2. Sign transition metadata using **current** trusted root.
3. Stage to non-production environment.
4. Run validation:
   - forward-only version (`new_version > current_version`)
   - `old_root_id` exists in current root set
   - `new_root_id` exists in next root set
   - non-empty transition signature
5. Promote to production only after validation passes.

## Validation Commands

Use existing trust-root validation path in MemphisOS startup/runtime checks.

Expected failure modes:

- downgrade attempt rejected
- unknown `old_root_id` rejected
- missing/empty signature rejected

## Rollback Rules

- Never load a lower `version` trust root.
- If rotation fails validation in production:
  1. keep current trusted root active
  2. emit security event
  3. investigate and re-run ceremony

## Evidence and Audit

Store the following artifacts with release records:

1. Signed transition metadata
2. New trust root manifest
3. Validation output/logs
4. Operator approvals
