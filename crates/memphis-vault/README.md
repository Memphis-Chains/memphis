# memphis-vault

DID, vault encryption, KDF, 2FA recovery. Everything secret-bearing in Memphis lives here.

## Public surface

- `did.rs` — Decentralized Identifier (`did:mph:...`) with ed25519 keys
- `keyring.rs` — Argon2id KDF (default 64 MiB / 3 iter / p=4); v1→v2 salt migration
- `crypto.rs` — AES-256-GCM with 12-byte nonce (random per encryption)
- `vault.rs` — vault entry persistence + master-key rotation (with fsync, post-#145)
- `two_factor.rs` — Q&A recovery (Argon2id over answer + HKDF combine; `Result`-returning since #144)
- `error.rs` — `VaultError` taxonomy

## Build

```bash
cargo build -p memphis-vault
cargo test -p memphis-vault --lib
```

ASan (weekly CI, Phase A3):

```bash
cargo +nightly test -p memphis-vault --lib -Z sanitizer=address
```

31/31 tests passing as of v1.3.0.

## Layer

L0 (Identity & Crypto). Used by `memphis-napi` (vault NAPI bindings), `memphis-operator` (Rust operator console resolves API keys here), and `memphis-core` (signature key resolution from vault).

## Security notes

- Vault state on-disk is `0o600` mode; vault dir is `0o700` (post-#135).
- Argon2id parameters are env-configurable (`MEMPHIS_VAULT_KDF_*`); defaults tuned to ~1.5s on Intel i3-2120 reference.
- Master-key rotation is atomic with fsync between writes (post-#145).
- 2FA recovery answer never stored in plaintext — hashed via Argon2id, combined with master key via HKDF.
