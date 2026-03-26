# Vault CLI (Phase 1 critical path)

Deterministic local vault flow through CLI:

```bash
# required for rust vault path
export RUST_CHAIN_ENABLED=true
export RUST_CHAIN_BRIDGE_PATH=./crates/memphis-napi
export MEMPHIS_VAULT_PEPPER='<12+ chars>'

# optional (defaults to ./data/vault-entries.json)
export MEMPHIS_VAULT_ENTRIES_PATH=./data/vault-entries.json

# init vault metadata
npx tsx src/infra/cli/index.ts vault init \
  --passphrase 'VeryStrongPassphrase!123' \
  --recovery-question 'pet?' \
  --recovery-answer 'nori' \
  --json

# add provider key to vault store
npx tsx src/infra/cli/index.ts vault add --key SHARED_LLM_API_KEY --value 'sk-...' --json

# read key back (decrypted for the explicit operator response path only)
npx tsx src/infra/cli/index.ts vault get --key SHARED_LLM_API_KEY --json

# list stored entries (metadata only, no plaintext)
npx tsx src/infra/cli/index.ts vault list --json
```

Operational notes:

- `vault get` returns plaintext only to the explicit operator response path.
- Vault plaintext must not be copied into prompt fragments, audit payloads, journal/soul writes, or background model output.
- `vault list` is metadata-only and does not decrypt stored values.
- `memphis setup matrix` stores pilot bootstrap secrets in the vault and should reference runtime tokens via `VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN` instead of writing plaintext secrets into `.env`.

Smoke coverage:

- `tests/unit/cli.vault.test.ts` (`vault init/add/get/list`)
- `tests/integration/vault-provider-key.e2e.test.ts` (provider key roundtrip via vault path)
