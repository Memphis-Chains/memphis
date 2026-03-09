# VAULT-API.md

Real-deal.

## Scope
Phase 1 vault HTTP + Rust/NAPI integration surface in current branch.

## Auth
All vault endpoints are protected and require API token when `MEMPHIS_API_TOKEN` is set.
Use header:

`Authorization: Bearer <MEMPHIS_API_TOKEN>`

Endpoints:
- `POST /v1/vault/init`
- `POST /v1/vault/encrypt`
- `POST /v1/vault/decrypt`
- `GET /v1/vault/entries`

## Endpoint contracts

### 1) POST `/v1/vault/init`
Request:
```json
{
  "passphrase": "VeryStrongPassphrase!123",
  "recovery_question": "pet?",
  "recovery_answer": "nori"
}
```

Responses:
- `200`:
```json
{ "ok": true, "vault": { "version": 1, "did": "did:memphis:..." } }
```
- `400` validation error
- `401` unauthorized
- `503` rust bridge unavailable/runtime failure

---

### 2) POST `/v1/vault/encrypt`
Request:
```json
{ "key": "openai_api_key", "plaintext": "secret-value" }
```

Responses:
- `200`:
```json
{
  "ok": true,
  "entry": {
    "key": "openai_api_key",
    "encrypted": "<base64>",
    "iv": "<base64>",
    "createdAt": "2026-..."
  }
}
```
- `400` validation error
- `401` unauthorized
- `503` rust bridge unavailable/runtime failure

---

### 3) POST `/v1/vault/decrypt`
Request:
```json
{
  "entry": {
    "key": "openai_api_key",
    "encrypted": "<base64>",
    "iv": "<base64>"
  }
}
```

Responses:
- `200`:
```json
{ "ok": true, "plaintext": "secret-value" }
```
- `400` validation error
- `401` unauthorized
- `503` rust bridge unavailable/runtime failure

---

### 4) GET `/v1/vault/entries`
Query params:
- optional `key` filter

Responses:
- `200`:
```json
{ "ok": true, "count": 1, "entries": [ ... ] }
```
- `401` unauthorized

## Cipher format + migration policy
- Current encrypted payload format is versioned:
  - `mv1:<base64-ciphertext>`
- Decrypt path is migration-safe and accepts:
  1. `mv1:<...>` (current format)
  2. `<base64-ciphertext>` (legacy no-prefix format)
  3. `plain:<plaintext>` (legacy scaffold fallback)

This allows progressive migration without breaking older stored entries.

## Verification commands
- Full quality + vault phase smoke:
  - `MEMPHIS_VAULT_PEPPER='<secret>=12+ chars' ./scripts/vault-phase1-smoke.sh`
- Runtime HTTP E2E (init -> encrypt -> decrypt -> entries integrity):
  - `MEMPHIS_VAULT_PEPPER='<secret>=12+ chars' ./scripts/vault-runtime-e2e.sh`

> Note: `vault-runtime-e2e.sh` uses an isolated mock Rust bridge file to validate runtime HTTP path deterministically, without depending on host-specific native bridge build state.

## Notes
- Current persistence scaffold stores entries in JSON file (`MEMPHIS_VAULT_ENTRIES_PATH` or `./data/vault-entries.json`).
- Crypto in Rust vault uses Argon2id + AES-256-GCM in current implementation.
- Feature-flag and bridge availability still determine operational path (`RUST_CHAIN_ENABLED`, `RUST_CHAIN_BRIDGE_PATH`).
