# Integration Tests

## Overview

Phase 0-1 integration tests validate the complete vault + embed + chain workflow.

## Test Suites

### vault_embed_chain_integration_test.rs

**Tests:**
1. `test_full_vault_embed_integration` - End-to-end workflow
2. `test_vault_2fa_with_embed_cache` - 2FA key derivation
3. `test_did_verification_workflow` - DID generation

> Rust test file location: `crates/memphis-vault/tests/vault_embed_chain_integration_test.rs`

### Running Tests

```bash
# Run Phase 0-1 integration test target
cargo test --workspace --test vault_embed_chain_integration_test

# Run with verbose output
cargo test --workspace --test vault_embed_chain_integration_test -- --nocapture
```

## Test Coverage

- ✅ Vault full init (passphrase + 2FA + DID)
- ✅ DID format validation (`did:memphis:...`)
- ✅ Q&A verification (case-insensitive)
- ✅ Embed store integration (store/search)
- ✅ 2FA key derivation (different answers = different keys)
- ✅ DID signature workflow (generation + storage)

## Dependencies

- `memphis-vault` - Vault with crypto + 2FA + DID
- `memphis-embed` - Vector store + cache + chain-aware search
- `memphis-core` - Chain primitives (`MemoryChain`, blocks)
