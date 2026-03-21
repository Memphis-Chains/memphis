# NAPI-CONTRACT-V1.md

Real-deal.

## Scope

Current Rust NAPI bridge contract used by Memphis runtime.

This contract is JSON-envelope based and intentionally thin.

## Naming contract

- Canonical export names are `snake_case`.
- TypeScript adapters may still accept historical `camelCase` aliases during transition.
- New object-based vault bridge exports are canonical as:
  - `vault_init_full`
  - `vault_store`
  - `vault_retrieve`
- Legacy envelope vault exports remain canonical as:
  - `vault_init_json`
  - `vault_encrypt`
  - `vault_decrypt`

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

### 4) `vault_init_json(request_json) -> string(JSON)`

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

## Vault object bridge (canonical runtime path)

### 6a) `vault_init_full(passphrase, qa_question, qa_answer) -> VaultInitResult`

Initializes the full vault runtime and returns the live vault object plus operator DID metadata.

### 6b) `vault_store(vault, key, plaintext) -> VaultEntry`

Encrypts a value using the initialized live vault object.

### 6c) `vault_retrieve(vault, entry) -> Buffer`

Decrypts an entry using the initialized live vault object.

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
- JSON-envelope functions avoid throwing; failures are returned in envelope.
- Object bridge functions use NAPI error returns, but their exported JS names are still canonical `snake_case`.
- Persistence/query expansion are outside v1 scope.
