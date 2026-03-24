# Vault Pepper Lifecycle

**Date:** 2026-03-24
**Scope:** `MEMPHIS_VAULT_PEPPER` provisioning, runtime requirements, and future rotation

---

## What is the Pepper?

`MEMPHIS_VAULT_PEPPER` is an environment variable containing a secret string (minimum 12 characters) used to derive the master encryption key for vault state v2.

It is **not** the vault passphrase — it is a separate, high-entropy secret that protects the vault's internal state file (`vault-state.json`).

```
┌─────────────────────────────────────────────────────┐
│                   vault-state.json                   │
│  { version: 2, pepper_id, encrypted_master_key, ... }│
└─────────────────────────────────────────────────────┘
                              │
                              ▼
         scrypt(MEMPHIS_VAULT_PEPPER, salt) → KEK
                              │
                              ▼
              AES-256-GCM decrypt(encrypted_master_key)
                              │
                              ▼
                        Master Key (DEK)
```

---

## Runtime Requirement

| Aspect | Value |
|--------|-------|
| **Minimum length** | 12 characters (enforced at runtime) |
| **Character set** | Any ASCII — no restrictions |
| **Stored in** | Environment variable `MEMPHIS_VAULT_PEPPER` |
| **In `.env`** | Supported — but must never be committed to git |
| **On missing** | Vault falls back to plaintext base64 (v1 format) with a warning |
| **On too short** | `503` error from vault adapter: "pepper too short" |

---

## Bootstrap Provisioning

During first-run setup, the pepper must be provided before `vault init` is called:

```bash
# Option 1: export before running
export MEMPHIS_VAULT_PEPPER="your-12-char-minimum-secret"
memphis vault init

# Option 2: .env file (never commit this)
echo 'MEMPHIS_VAULT_PEPPER="your-12-char-minimum-secret"' >> .env
memphis vault init

# Option 3: inline (visible in process list — not recommended)
MEMPHIS_VAULT_PEPPER="your-12-char-minimum-secret" memphis vault init
```

**Bootstrap order:**
1. Set `MEMPHIS_VAULT_PEPPER` environment variable
2. Run `memphis vault init --passphrase <pass> --question <question> --answer <answer>`
3. Vault state v2 is created with pepper-derived key
4. `vault-state.json` is written to `data/vault-state.json`

---

## Key Derivation

The pepper is processed via `scrypt` (from `rust-vault-adapter.ts:137-143`):

```typescript
const salt = crypto.randomBytes(16);  // stored in vault-state.json
const key = crypto.scryptSync(
  pepper,
  salt,
  32,      // key length (AES-256)
  16384,   // CPU/memory cost parameter (N)
  8,       // block size (r)
  16384    // parallelization (p)
);
```

This derives a 256-bit key used to encrypt the vault's master key (DEK) with AES-256-GCM.

---

## No Rotation Strategy Currently Exists

**This is a known gap.** The current implementation:

1. Has no CLI command to rotate the pepper
2. Has no automated rotation on vault unlock
3. Has no migration path when pepper rotation is added

Any future pepper rotation would require:
- Re-encrypting the vault's internal DEK with the new pepper-derived KEK
- A ledger entry recording the rotation event
- Downtime or a lockout window for the vault

This is tracked as **planned work** — see `docs/KEY-ROTATION-DESIGN.md` for the longer-term DEK/KEK ring model that would subsume the pepper.

---

## Relationship to Key Rotation Design

`docs/KEY-ROTATION-DESIGN.md` describes a full DEK/KEK key ring model:

```
Key Ring:
  version | state | purpose | encrypted_key | rotated_at
  ─────────────────────────────────────────────────────
  v1      | active| root     | DEK-encrypted  | 2026-03-10
```

The pepper is conceptually a **KEK (Key Encryption Key)** in this model, but:
- The KEY-ROTATION-DESIGN doc does not mention the pepper
- The pepper lifecycle is not integrated into the rotation design
- When key rotation is implemented, the pepper should be treated as the root KEK with its own rotation path

---

## Security Notes

- **No secrets in git** — `MEMPHIS_VAULT_PEPPER` must not be committed. Add to `.gitignore`.
- **Pepper ≠ passphrase** — The passphrase is what the user enters to unlock the vault; the pepper is an internal server-side protection.
- **If compromised** — Anyone with the pepper can decrypt `vault-state.json` and recover the master key. Treat the pepper as a server secret like a database password.

---

## References

- `src/infra/storage/rust-vault-adapter.ts:137-143` — scrypt key derivation
- `docs/PR-NOTES-VAULT-PHASE1.md` — vault Phase 1 implementation notes
- `docs/KEY-ROTATION-DESIGN.md` — future key rotation design
