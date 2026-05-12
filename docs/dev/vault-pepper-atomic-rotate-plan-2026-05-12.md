# Vault pepper rotation — atomic re-encrypt plan

**Status.** RESOLVED via audit 2026-05-12 — **no implementation needed**.
Original plan was based on a misdiagnosis of the 2026-05-11 incident.
Keeping this doc as the audit record + future-defense (regression test
in `tests/unit/vault-pepper-invariants.test.ts` locks in the
single-artifact invariant the audit confirmed).

## Original concern (2026-05-12 morning)

Memory `feedback_pepper_desync_twice_same_day` flagged a P0 follow-up
to "atomic re-encrypt every pepper-keyed artifact". The hypothesis
was: `rotateVaultStatePepper` re-wraps the master key but leaves
**other** pepper-derived artifacts orphaned, which is why the
2026-05-11 vault desync happened.

## Audit finding (2026-05-12 evening)

A grep across `src/**/*.ts` and `crates/**/*.rs` for every consumer
of `MEMPHIS_VAULT_PEPPER` / `pepper.as_bytes()` /
`deriveStateEncryptionKey` finds **exactly one** persistent artifact
encrypted with a pepper-derived key:

| Artifact | Path | Encrypts |
|---|---|---|
| **`vault-state.json`** | `~/.memphis/vault-state.json` (resolved via `resolveVaultPath`) | The 32-byte master key (AES-256-GCM, key = `scryptSync(pepper, 'memphis-vault-state-v2', 32, …)`) |

Every other pepper consumer turned out to be:

- `crates/memphis-operator/src/runtime.rs:1183-1196` — **read path** that
  decrypts `vault-state.json` to recover the master key. Same artifact,
  not a separate encryption.
- `crates/memphis-operator/src/provider.rs:2618` — inside
  `#[cfg(test)] fn write_v2_vault_secret(dir: &TestProviderDir, …)`. **Test
  helper**, not production code.
- `crates/memphis-vault/src/keyring.rs:46` — `derive_master_key_v1_compat`
  (deprecated v1 path). Not invoked by current rotate.
- `src/sync/trade.ts:24` — pepper used as **in-memory signing key** for
  sync trades. Trades are non-durable; on pepper rotate the in-flight
  trades become unverifiable, which is fine (operator re-issues).
- `data/tier3-sessions.json` — **plaintext JSON, chmod 0600**. Not
  pepper-encrypted (this contradicted the original plan; doc fixed).

## Why the existing rotate is already atomic

`rotateVaultStatePepper` in `src/infra/storage/rust-vault-adapter.ts`:

1. Reads `vault-state.json`.
2. Decrypts master key with the OLD pepper-derived state-encryption key.
3. Re-serializes the same master key with the NEW pepper-derived key.
4. Atomic write: `tmp-${pid}-${now}` → `chmod 0600` → `renameSync` to
   the canonical path.
5. Updates in-memory `activeVault`.

The handler (`src/infra/cli/handlers/vault.handler.ts:551-621`) wraps
this in a try/catch: if `.env` write fails AFTER the state rotate, it
attempts a reverse rotation so disk state stays in sync with the
unchanged `.env`. Audit-stamped both directions.

**Vault entries** (`vault-entries.json`) are encrypted under the
master key (not pepper). Pepper rotation preserves the master key, so
entries are untouched + readable through any number of rotations.

## Real root cause of the 2026-05-11 incident

Per memory `project_real_timeline.md` + the
`docs/dev/2026-05-11-pepper-incident-postmortem.md` summary: the
incident was a **cwd bug** — pepper-rotate wrote the new pepper to
`$HOME/.env` instead of `~/memphis/.env` (operator ran it from
outside the repo root, so `cwd != HOME_OF_MEMPHIS`). Manual
remediation desynced disk state.

That cwd bug was fixed in v1.9.x — see the v1.10.0 CHANGELOG entry
for `memphis vault pepper-rotate cwd anchoring`. After that fix,
the existing atomic rotate is sufficient.

## What ships instead of the 12-16h crypto sprint

1. **This audit doc** — captures the finding so the next agent who reads
   `feedback_pepper_desync_twice_same_day` doesn't re-derive the
   12-16h plan from scratch.
2. **`tests/unit/vault-pepper-invariants.test.ts`** — locks in the
   single-artifact invariant. Grep-asserts that `vault-state.json` is
   the only path that `deriveStateEncryptionKey` writes to, and that
   no NEW production-side caller uses pepper as a direct encryption
   key. If a future PR adds a second pepper-encrypted artifact, this
   test fails and the contributor either:
   - Adds the new artifact to `rotateVaultStatePepper`'s walker
     (legitimate expansion), OR
   - Removes the direct-pepper key (use master-key-derived instead).
3. **Operator runbook clarification** — `docs/operator/VAULT-RECOVERY-
   RUNBOOK.md` notes that pepper rotation only re-wraps the master
   key, so entries are preserved across rotations. (Already covered
   indirectly; can refresh if needed.)

## Memory updates

- `feedback_pepper_desync_twice_same_day.md` → mark the "atomic
  re-encrypt PR is highest-priority engineering item" line as
  superseded by this audit. The real fix was the cwd anchor (v1.9.x).
- `project_pepper_audit_2026-05-12.md` → add an entry summarizing
  the audit + the invariant test.

## If a future pepper-encrypted artifact is introduced

The plan-doc skeleton below remains valid; just substitute the new
artifact for "vault-state.json" in the walker design.

### Skeleton plan (preserved for future reuse)

**Phase 1.** Write `re_encrypt(old_pepper, new_pepper, path) → Result<()>`
for each new artifact kind. Decrypt-with-old, re-encrypt-with-new, write
staging `{path}.rotating`.

**Phase 2.** Two-phase commit in `handleVaultPepperRotate`: walker
enumerates artifacts → Phase A (write all `.rotating`, abort if any
fail), Phase B (rename all in deterministic order, vault-state.json
last). `pepper-rotation-in-progress.json` marker. `recover-rotation`
CLI verb for partial-apply.

**Phase 4.** Failure-injection tests + perf gate.

(Phase 3 = CLI surface is already covered by the existing rotate
handler.)
