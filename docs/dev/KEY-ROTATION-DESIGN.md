# Key Rotation Design (P1)

## Status

Design approved for future implementation (no runtime changes in this task).

## Goals

- Limit blast radius if any signing/encryption key is exposed.
- Support zero-downtime key rollover.
- Preserve verification of historical artifacts.
- Provide auditable evidence of key lifecycle events.

## Scope

Applies to:

- API signing keys (service-to-service auth)
- Data-at-rest encryption keys (DEK/KEK model)
- Optional plugin/client secrets

## Rotation Model

### 1) Versioned Key Ring

Each key has metadata:

- `keyId` (immutable, unique)
- `version` (monotonic)
- `state` (`active`, `grace`, `retired`, `revoked`)
- `createdAt`, `activateAt`, `retireAt`
- `algorithm` and `purpose`

Only one key per purpose is `active` for new writes/signatures.

### 2) Dual-Read / Single-Write

- **Write/sign** with current `active` key.
- **Read/verify/decrypt** with `active` + `grace` keys.
- After grace window ends, old key becomes `retired`.

### 3) Envelope Encryption

For data encryption:

- Per-record DEK encrypts payload.
- DEK encrypted by current KEK (stored as wrapped DEK + `kekKeyId`).
- Rotation can re-wrap DEKs without rewriting payload when possible.

## Rotation Triggers

- Scheduled rotation (default every 90 days for auth/signing keys, 180 days for KEK).
- Emergency rotation after suspected compromise.
- Algorithm policy updates (e.g., deprecations).

## Operational Workflow

### Planned Rotation

1. Generate new key in KMS/HSM.
2. Publish as `grace` (not active yet).
3. Health check: verify all services can load/verify with new key.
4. Promote key to `active`.
5. Keep previous key in `grace` for fixed window (e.g., 14 days).
6. Retire old key and emit audit event.

### Emergency Rotation

1. Create new key and immediately set active.
2. Mark compromised key as `revoked`.
3. Force re-auth/re-sign where required.
4. Trigger incident workflow and forensics tagging.

## Audit & Compliance

All key lifecycle actions must be audit logged:

- `key.created`
- `key.activated`
- `key.rotated`
- `key.retired`
- `key.revoked`

Audit record fields:

- actor/service
- purpose
- old/new `keyId`
- reason (`scheduled`, `emergency`, `policy`)
- timestamp and correlation ID

## Backward Compatibility

- Verification/decryption must support at least one previous key version during grace.
- Historical signed artifacts keep embedded `keyId` for deterministic verification.

## Failure Modes & Mitigations

- **Clock drift:** Use server-side activation timestamps from a single authority.
- **Partial rollout:** Rotation blocked unless all critical nodes report key ring sync.
- **KMS outage:** Keep encrypted local cache of currently active key material with strict TTL.

## Implementation Plan (Future Work)

1. Add key registry interface (`KeyProvider`) with version/state APIs.
2. Add key metadata to signed envelopes and encrypted records.
3. Build rotation job + admin CLI command.
4. Add observability (rotation duration, failures, stale nodes).
5. Add runbook and chaos tests for emergency rotation.

## Acceptance Criteria

- Rotation with no downtime.
- Old signatures verifiable during grace.
- Revoked keys rejected immediately.
- Full audit trail for each key transition.
