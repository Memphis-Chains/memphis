# NAPI-CONTRACT-V1.md

Real-deal.

## Scope
Current Rust NAPI bridge contract used by memphis-v4 runtime.

This contract is JSON-envelope based and intentionally thin.

## Response envelope (all functions)
- success: `{ "ok": true, "data": <payload>, "error": null }`
- failure: `{ "ok": false, "data": null, "error": "..." }`

Compatibility rule: keep keys `ok`, `data`, `error` stable.

## Chain functions

### 1) `chain_validate(block_json, prev_json?) -> string(JSON)`
Validates one block against optional previous block.

- parse errors:
  - `invalid_block_json: ...`
  - `invalid_prev_json: ...`
- success data:
  - valid: `{ "valid": true }`
  - invalid: `{ "valid": false, "errors": string[] }`

### 2) `chain_append(chain_json, block_json) -> string(JSON)`
Validates + appends block to a chain array.

- parse errors:
  - `invalid_chain_json: ...`
  - `invalid_block_json: ...`
- success data:
  - appended: `{ "appended": true, "length": number, "chain": Block[] }`
  - rejected: `{ "appended": false, "errors": string[] }`

### 3) `chain_query(chain_json, contains?, tag?) -> string(JSON)`
Simple chain filter.

- parse errors:
  - `invalid_chain_json: ...`
- success data:
  - `{ "count": number, "blocks": Block[] }`

## Vault functions (Phase 1 runtime)

### 4) `vault_init(request_json) -> string(JSON)`
Initializes vault metadata from `VaultInitRequest`.

- parse errors:
  - `invalid_vault_init_json: ...`
- runtime errors:
  - `vault_init_failed: ...`
- success data:
  - `{ "version": 1, "did": "did:memphis:..." }`

### 5) `vault_encrypt(key, plaintext) -> string(JSON)`
Encrypts secret into `VaultEntry`.

- runtime errors:
  - `vault_encrypt_failed: ...`
- success data:
  - `VaultEntry` (`key`, `encrypted`, `iv`)

### 6) `vault_decrypt(entry_json) -> string(JSON)`
Decrypts a `VaultEntry` payload.

- parse errors:
  - `invalid_vault_entry_json: ...`
- runtime errors:
  - `vault_decrypt_failed: ...`
- success data:
  - `{ "plaintext": string }`

## Embed functions (Phase increment)

### 7) `embed_store(id, text) -> string(JSON)`
Embeds and upserts one document in in-memory pipeline.

- runtime errors:
  - `embed_store_failed: ...`
- success data:
  - `{ "id": string, "count": number, "dim": number, "provider": string }`

### 8) `embed_search(query, top_k?) -> string(JSON)`
Embeds query and returns top cosine matches.

- runtime errors:
  - `embed_search_failed: ...`
- success data:
  - `{ "query": string, "count": number, "hits": [{ "id": string, "score": number, "text_preview": string }] }`

### 9) `embed_reset() -> string(JSON)`
Clears in-memory embed pipeline state.

- success data:
  - `{ "cleared": true }`

## Notes
- TS runtime may still fall back to legacy path when bridge is disabled/unavailable.
- This contract avoids throwing; failures are returned in envelope.
- Persistence/query expansion are outside v1 scope.
