# Vault pepper rotation — atomic re-encrypt plan

**Status.** Design (2026-05-12). Replaces the never-pushed Coder B PR per memory `feedback_pepper_desync_twice_same_day`. Awaiting operator sign-off before implementation.

## Why we need this

Memory `feedback_pepper_desync_twice_same_day` (P0 follow-up): the vault pepper-rotate path rewraps the master key under the new pepper but leaves OTHER pepper-derived artifacts orphaned. Operator hit this twice on 2026-05-11 — vault refused decrypt after rotation because tier-3 session blobs / provider secret bundles / sync-trade signing keys were still tied to the old pepper.

Current rotate implementation: `src/infra/cli/handlers/vault.handler.ts:471` → `rotateVaultStatePepper(oldPepper, newPepper, env)`. That function rewraps `data/vault-state.json` only. Everything else is left to drift.

## Pepper consumers (audit 2026-05-12)

| Consumer | Location | Mode | Rotation handling |
|---|---|---|---|
| Vault master key wrapping | `crates/memphis-vault/src/vault.rs:151,162` | `derive_master_key_v2(pepper)` → wraps master | ✅ Current rotate handles |
| Provider v2 secrets | `crates/memphis-operator/src/provider.rs:write_v2_vault_secret` | aead-encrypted under pepper-derived key | ❌ NOT walked |
| Operator runtime crypto | `crates/memphis-operator/src/runtime.rs:1183-1191` | pepper passed to crypto primitive (need re-read) | ❌ NOT walked |
| Sync trade signing | `src/sync/trade.ts:24` | pepper used directly as signing key material | ⚠ Non-durable: trades are ephemeral, but in-flight trades may fail to verify after rotate. Likely acceptable. |
| Tier-3 session blobs | `data/tier3-sessions.json` (encrypted) | likely pepper-derived (per memory `feedback_pepper_desync_twice_same_day`) | ❌ NOT walked |
| Chain block payloads | `~/.memphis/chains/<chain>/*.json` | NOT pepper-encrypted (Ed25519 signed, payloads plaintext per spec) | n/a |

The two REAL blockers: provider v2 secrets + tier-3 session blobs. These break the operator's daily use immediately on rotate.

## Atomic re-encrypt plan

### Phase 1 — Audit + write paths (NO rotate yet)

1. Read each consumer's KDF input + output format. Produce a `PepperKeyedArtifact` enumeration:
   ```ts
   type PepperKeyedArtifact =
     | { kind: 'vault-state'; path: string }           // already handled
     | { kind: 'provider-secret'; path: string }       // crates/memphis-operator/provider.rs
     | { kind: 'tier3-session'; path: string }
     | { kind: 'operator-runtime'; path: string };     // if applicable
   ```
2. For each kind, expose a Rust function `re_encrypt(old_pepper, new_pepper, path) -> Result<()>`:
   - Decrypt with old pepper-derived key.
   - Re-encrypt with new pepper-derived key.
   - Write to `{path}.rotating` (staging, not atomic yet).
3. No rotate yet — just write the primitives + unit tests.

### Phase 2 — Atomic flip

1. Add `vault.handler.ts:handleVaultPepperRotate` walker that enumerates all artifact paths.
2. Two-phase commit:
   - **Phase A (write):** For each artifact, decrypt-with-old + write `{path}.rotating` with new-encrypted bytes. If ANY artifact fails decrypt-or-encrypt, abort + delete all `.rotating` files. Vault state untouched.
   - **Phase B (flip):** `rename({path}.rotating, {path})` for each artifact in deterministic order: provider secrets → tier-3 sessions → vault-state.json last (since vault is the lookup key for everything else). `.env` flip happens AFTER all renames succeed.
3. Failure during Phase B is the dangerous window. Mitigation:
   - Write a `data/pepper-rotation-in-progress.json` marker file before Phase B begins, listing all `(path, sha256-of-rotating-file)` pairs.
   - On daemon startup, if marker exists, refuse to boot until `memphis vault recover-rotation` is run.
   - `recover-rotation` reads marker, retries failed renames, OR (operator confirms) reverts every successful rename to its `.pre-rotate` backup.
4. Each artifact gets `{path}.pre-rotate` snapshot before being touched (under old pepper still readable), kept for 7 days then garbage-collected by `memphis vault gc`.

### Phase 3 — CLI surface

- `memphis vault pepper-rotate --confirm` → existing flow, now walks all artifacts.
- `memphis vault recover-rotation` → resumes / aborts a partially-applied rotation.
- `memphis vault list-pepper-artifacts` → diagnostic, prints every file that would be touched by a rotate.

### Phase 4 — Test surface (mandatory before merging)

- Unit: each `re_encrypt(kind, ...)` round-trips correctly.
- Integration: full rotation against a tmp Memphis home with all 4 artifact kinds present. Assert post-rotate, every artifact decrypts under new pepper AND fails under old pepper.
- Failure injection: simulate fs error mid-Phase-B; assert `pepper-rotation-in-progress.json` written + `recover-rotation` restores cleanly.
- Performance: rotate with 1000 vault entries + 500 tier-3 sessions completes in < 30 s on the GTX-960-grade install.

## Out of scope (this iteration)

- KDF parameter migration (e.g. argon2 cost increase). Separate concern.
- Hardware-backed pepper storage (Yubikey, TPM). Tracked in `docs/roadmap/`.
- Federation sync of pepper across multiple operator hosts.

## Risks

- **Crypto correctness.** Mis-routing an artifact's re-encrypt = unrecoverable data loss for that artifact. Tests in Phase 4 must enumerate every kind; any newly-introduced pepper-keyed artifact MUST register itself with the walker or rotate refuses to proceed (audit-trail-by-design).
- **Time-of-check vs time-of-use.** If the daemon writes a new artifact during Phase B, it could land under the OLD pepper after the flip. Mitigation: rotate refuses to proceed unless daemon is stopped (operator already required to be tier-3 for rotate; ask the daemon to drain first).
- **Memory cost.** Walking 500+ tier-3 sessions in memory at once is fine; for chains the count could be 100k+ (if ever pepper-keyed in future) — currently they aren't, so not a blocker for v1.

## Time estimate

- Phase 1: 4-6 h focused (Rust re-encrypt primitives + tests per artifact kind).
- Phase 2: 3-4 h (walker + atomic flip + marker file).
- Phase 3: 1-2 h (CLI verbs + doctor visibility).
- Phase 4: 3-4 h (test matrix, including failure injection).

Total: ~12-16 h. Should be done across two sessions with operator review between Phase 2 and Phase 3.

## Decision pending

- ✅ Plan structure agreeable?
- ⏳ Awaiting operator: greenlight to start Phase 1, or first audit `crates/memphis-operator/src/runtime.rs:1183-1191` more carefully to confirm whether it's pepper-keyed durable state or just runtime-only key material?
