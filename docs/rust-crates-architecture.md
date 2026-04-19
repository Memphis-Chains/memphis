# MemphisOS Rust Crates — Architecture & Interplay

## 1. Crate Dependency Graph

```
                        ┌──────────────────┐
                        │  memphis-napi   │
                        │  (cdylib/NAPI)  │
                        │  #[napi] bridge │
                        └────────┬─────────┘
                                 │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐      ┌─────────────────┐      ┌──────────────────┐
│memphis-core   │      │  memphis-vault  │      │memphis-embed     │
│ (foundation)  │      │  (standalone)    │      │                  │
│               │      │                 │      │ depends on       │
│ • Block       │      │ • AES-256-GCM   │      │ memphis-core     │
│ • SHA-256     │      │ • Argon2id KDF  │      │   ↕              │
│ • Ed25519 sig │      │ • Ed25519 DID   │      │ MemoryChain      │
│ • Soul valid. │      │ • 2FA (HKDF)    │      │ Block            │
│ • Loop engine │      │ • No internal   │      │                  │
│ • Harness     │      │   crate deps     │      │                  │
└───────┬───────┘      └─────────────────┘      └────────┬─────────┘
        │                                                  │
        │            ┌──────────────────┐                 │
        │            │memphis-case-index│                 │
        │            │                  │                 │
        │            │ depends on       │                 │
        └───────────►│ memphis-core     │◄────────────────┘
                     │                  │
                     │ Block, BlockType │
                     │ CaseEntry        │
                     │ CaseQuery        │
                     └──────────────────┘
```

---

## 2. Dependency Summary Table

| Crate                | Depends On       | Nature                                         | Exports                                                                                       |
| -------------------- | ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `memphis-core`       | _(none)_         | Self-contained                                 | Block, SHA-256, Ed25519, Soul validation, Loop engine, Harness replay, CaseEntry, MemoryChain |
| `memphis-vault`      | _(none)_         | Fully standalone                               | AES-256-GCM, Argon2id, DID generation, 2FA/HKDF, Vault operations                             |
| `memphis-embed`      | `memphis-core`   | `MemoryChain`, `Block` types                   | EmbedPipeline, VectorStore, ChainRef, HNSW-like search, LRU cache                             |
| `memphis-case-index` | `memphis-core`   | `Block`, `BlockType`, `CaseEntry`, `CaseQuery` | SQLite-backed case index, 8 grammatical cases                                                 |
| `memphis-napi`       | All of the above | Aggregator/dispatcher                          | NAPI exports: chain*\*, vault*\*, embed*\*, case*\*, soul\_\*                                 |

---

## 3. memphis-core — The Foundation

**Path:** `crates/memphis-core/src/`

### Modules

| Module        | File             | Purpose                                                                                            |
| ------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `block`       | `block.rs`       | `Block`, `BlockData`, `BlockType` enum (Journal, Ask, Decision, Case, ToolCall, etc.)              |
| `hash`        | `hash.rs`        | `compute_hash()` — deterministic SHA-256 of a block (canonical JSON, excludes `hash` field itself) |
| `signature`   | `signature.rs`   | Ed25519 sign/verify blocks, allowlist-based policy enforcement                                     |
| `soul`        | `soul.rs`        | `validate_block()` and `validate_block_strict()` — chain integrity enforcement                     |
| `chain`       | `chain.rs`       | `MemoryChain` — in-memory blockchain with append                                                   |
| `loop_engine` | `loop_engine.rs` | `LoopState`, `LoopAction`, `LoopLimits` — agent execution state machine                            |
| `harness`     | `harness.rs`     | `replay()` — deterministic block sequence validation                                               |
| `memory`      | `memory.rs`      | `MemoryStore` — keyword/tag-based block recall                                                     |
| `case_entry`  | `case_entry.rs`  | 8 Polish grammatical cases for semantic relations                                                  |
| `error`       | `error.rs`       | `MemphisError` enum                                                                                |

### Key Types

```rust
// Block
pub struct Block {
    pub index: u64,
    pub timestamp: String,         // RFC3339
    pub chain: String,
    pub data: BlockData,
    pub prev_hash: String,        // 64-char hex
    pub hash: String,             // computed SHA-256
    pub signer: Option<String>,
    pub signature: Option<String>,
}

pub enum BlockType {
    Journal, Ask, Decision, System, SystemEvent,
    Insight, ToolCall, ToolResult, Error, Case,
    WalletTxRequested, WalletTxSigned, WalletTxBroadcast,
    WalletTxConfirmed, WalletTxFailed,
}

// Loop engine
pub struct LoopState {
    pub steps: u32, pub tool_calls: u32, pub wait_ms: u64,
    pub errors: u32, pub completed: bool, pub halt_reason: Option<String>,
}

pub enum LoopAction { ToolCall, Wait, Complete, Error }
pub struct LoopLimits {
    pub max_steps: u32,      // default 32
    pub max_tool_calls: u32, // default 16
    pub max_wait_ms: u64,    // default 120_000
    pub max_errors: u32,     // default 4
}

// Case entry (8 Polish grammatical cases)
pub enum CaseType {
    Nominative, Genitive, Dative, Accusative,
    Instrumental, Locative, Ablative, Vocative,
}
pub struct CaseEntry { pub case_type: CaseType, /* ... case-specific fields */ }
pub struct CaseQuery { pub case_type: Option<CaseType>, entity, actor, target, instrument, location, limit }
```

### compute_hash

```rust
pub fn compute_hash(block: &Block) -> String
// Canonical JSON of (index, timestamp, chain, data, prev_hash)
// Returns 64-char hex string (256-bit)
// Panics on serialization failure (fail-loud)
```

### validate_block (Soul)

Checks:

1. Chain name valid (no null bytes, no path traversal `..`, `/`, `\`)
2. Content non-empty
3. Timestamp valid RFC3339
4. Hash matches computed hash
5. Signature verifies (if present)
6. Genesis block: index 0 or 1, prev_hash = 64 zeros
7. Non-genesis: sequential index, prev_hash links, timestamp >= previous

`validate_block_strict` adds: **requires valid signature** (reject unsigned blocks).

---

## 4. memphis-vault — Standalone Crypto

**Path:** `crates/memphis-vault/src/`

> **Key finding:** No production dependencies on any other `memphis-*` crate. Fully standalone.

### Modules

| Module       | File            | Purpose                                                        |
| ------------ | --------------- | -------------------------------------------------------------- |
| `lib`        | `lib.rs`        | Re-exports all public types                                    |
| `crypto`     | `crypto.rs`     | Thin AES-256-GCM wrapper                                       |
| `did`        | `did.rs`        | Memphis DID generation/verification (Ed25519)                  |
| `error`      | `error.rs`      | `VaultError` enum                                              |
| `keyring`    | `keyring.rs`    | Argon2id KDF, salt generation                                  |
| `two_factor` | `two_factor.rs` | Q&A 2FA derivation (HKDF v2 + legacy XOR v1)                   |
| `types`      | `types.rs`      | Serde-serializable request/response structs                    |
| `vault`      | `vault.rs`      | `Vault` struct, `init_vault`, `encrypt_entry`, `decrypt_entry` |

### Crypto Stack

| Primitive       | Algorithm                                                         | Crate               |
| --------------- | ----------------------------------------------------------------- | ------------------- |
| Encryption      | AES-256-GCM (12-byte nonce, 16-byte auth tag)                     | `aes-gcm 0.10`      |
| Master key KDF  | Argon2id (`m=65536, t=3, p=4, len=32`)                            | `argon2 0.5`        |
| DID signing     | Ed25519 (32-byte secret + 32-byte public + 64-byte sig)           | `ed25519-dalek 2.1` |
| 2FA v2 KDF      | HKDF-SHA256 (salt = QA SHA-256, info = `b"memphis-vault-2fa-v2"`) | `hkdf 0.12`         |
| 2FA v1 (legacy) | XOR with SHA-256 of answer                                        | _(deprecated)_      |
| Answer hashing  | SHA-256 (lowercase + trimmed)                                     | `sha2 0.10`         |

### DID Format

```
did:memphis:z<multibase-base58btc>
Payload: [0xed, 0x01] + 32-byte-Ed25519-pubkey
```

### Key Functions

```rust
// Key derivation
fn derive_master_key(passphrase: &str, salt: &[u8; 32]) -> Result<[u8; 32], VaultError>
// Argon2id, m=65536, t=3, p=4, len=32

// Vault operations
fn init_vault(request: VaultInitRequest) -> Result<LegacyVaultInitResult, VaultError>
fn encrypt_entry(plaintext: &[u8], key: &[u8; 32]) -> Result<VaultEntry, VaultError>
fn decrypt_entry(entry: &VaultEntry, key: &[u8; 32]) -> Result<Vec<u8>, VaultError>

// Vault struct
impl Vault {
    fn init(passphrase: &str)               // Generates random 32-byte salt, Argon2id derives master key
    fn init_full(config: VaultInitConfig)   // Full: master key + 2FA challenge + DID + encrypted DID key
    fn store(&self, key: &str, plaintext: &str) -> Result<VaultEntry, VaultError>
    fn retrieve(&self, entry: &VaultEntry) -> Result<String, VaultError>
}

// 2FA
fn derive_vault_key_with_2fa(master_key: &[u8; 32], qa_answer: &str) -> [u8; 32]
// HKDF-SHA256 over master key IKM with QA hash as salt
```

### Exported Types

```rust
pub struct VaultConfig { pepper, iterations, memory, qa_challenge, did }
pub struct VaultEntry { id, key, ciphertext, nonce, tag, created_at }
pub struct VaultInitRequest { pepper, iterations, memory }
pub struct MemphisDid { did, public_key: base64url, created_at }
pub struct QAChallenge { question, answer_hash: SHA256_hex, created_at }
pub struct DerivationMeta { salt: [u8; 32], version: u8 } // 1=zero-salt, 2=random-salt
```

---

## 5. memphis-embed — Vector Search + Chain Awareness

**Path:** `crates/memphis-embed/src/`

> **Depends on:** `memphis-core` (for `MemoryChain`, `Block` types)

### Modules

| Module              | File                   | Purpose                                                                |
| ------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `pipeline`          | `pipeline.rs`          | `EmbedPipeline` orchestrates embedding, providers, persistence, search |
| `store`             | `store.rs`             | `VectorStore` — in-memory vectors, disk persistence, `ChainRef`        |
| `chain_integration` | `chain_integration.rs` | `ChainAwareEmbedStore` bridges VectorStore with MemoryChain            |
| `cache`             | `cache.rs`             | LRU cache with TTL for embedding results                               |
| `error`             | `error.rs`             | `EmbedError` enum                                                      |

### Embedding Providers

```rust
pub enum EmbedMode {
    LocalDeterministic,           // Built-in deterministic embeddings (in-process)
    Ollama,                       // Ollama /api/embeddings (real semantic vectors, dim-auto-truncate/pad)
    OpenAICompatible,             // OpenAI-compatible /v1/embeddings (DeepSeek, Cohere, Voyage, Jina, Mistral, Together, NVIDIA, MixedBread, etc.)
}

pub struct EmbedConfig {
    pub mode: EmbedMode,
    pub dim: usize,               // default 32
    pub max_text_bytes: usize,    // default 4096
    pub provider_url: Option<String>,
    pub provider_api_key: Option<String>,
    pub provider_model: Option<String>,
    pub provider_timeout_ms: u64, // default 8000
}
```

### ChainRef — Bridging Vectors to Chain Blocks

```rust
pub struct ChainRef {
    pub chain: String,   // e.g., "journal", "cases"
    pub index: u64,      // Block index in chain
    pub hash: String,    // Block hash for verification
}

pub struct VectorEntry {
    pub id: String,
    pub vector: Vec<f32>,
    pub metadata: HashMap<String, String>,
    pub created_at: i64,
    pub chain_ref: Option<ChainRef>,  // Links to source block
}
```

### ChainAwareEmbedStore Integration

```rust
impl ChainAwareEmbedStore {
    pub fn store_from_chain(
        &self,
        chain: &MemoryChain,       // from memphis-core
        block_index: u64,
        vector: Vec<f32>,
        metadata: HashMap<String, String>,
    ) -> Result<String, EmbedError> {
        // 1. Look up block via chain.blocks.iter().find(|b| b.index == block_index)
        // 2. Extract ChainRef { chain.name, block_index, block.hash }
        // 3. Store VectorEntry with chain_ref: Some(ChainRef)
    }

    pub fn search_with_context(
        &self,
        query: &str,
        top_k: usize,
        chain: Option<&MemoryChain>,
    ) -> Result<Vec<(f32, VectorEntry, Option<String>)>, EmbedError> {
        // Returns (score, entry, block_content) triples
        // If chain provided, looks up block content for enrichment
    }
}
```

### EmbedPipeline Key Methods

```rust
pub struct EmbedPipeline { /* ... */ }

impl EmbedPipeline {
    pub fn with_persistence(config: EmbedConfig, persistence: EmbedPersistenceConfig) -> Result<Self, EmbedError>
    pub fn upsert_with_tags(&mut self, id: String, text: String, tags: Vec<String>) -> Result<usize, EmbedError>
    pub fn search_with_tags(&self, query: &str, top_k: usize, filter_tags: Option<&[String]>) -> Result<Vec<SearchHit>, EmbedError>
    pub fn search_tuned_with_tags(&self, query: &str, top_k: usize, filter_tags: Option<&[String]>) -> Result<Vec<SearchHit>, EmbedError>
    // search_tuned: hybrid search combining vector similarity + lexical overlap scoring
}
```

---

## 6. memphis-case-index — SQLite Case-Based Index

**Path:** `crates/memphis-case-index/src/`

> **Depends on:** `memphis-core` (for `Block`, `BlockType`, `CaseEntry`, `CaseQuery`)

### Single Module: `lib.rs`

Contains: `CaseIndex`, `CaseIndexRow`, `RebuildReport`, `CaseIndexError`

### SQLite Schema

```sql
CREATE TABLE case_entries (
    block_index INTEGER PRIMARY KEY,
    block_hash TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'cases',
    case_type TEXT NOT NULL,
    -- 8 grammatical case fields (denormalized):
    entity, actor, target, instrument, location,
    origin, destination, owner, possessed,
    giver, recipient, object, subject, verb,
    invoker, invocation, entry_timestamp,
    full_json TEXT NOT NULL,
    indexed_at TEXT NOT NULL
);
-- 8 indexes on query fields
```

### Key Functions

```rust
pub struct CaseIndex { /* sqlite connection */ }

impl CaseIndex {
    pub fn open(path: &Path) -> Result<Self, CaseIndexError>
    pub fn open_in_memory() -> Result<Self, CaseIndexError>  // for tests

    pub fn index_block(&self, block: &Block) -> Result<bool, CaseIndexError>
    // Filters: matches!(block.data.block_type, BlockType::Case)
    // Parses: CaseEntry::from_block_content(&block.data.content)
    // Extracts: denormalized fields from CaseEntry via helper functions
    // Returns: true if indexed, false if skipped (non-Case block)

    pub fn query(&self, q: &CaseQuery) -> Result<Vec<CaseIndexRow>, CaseIndexError>

    pub fn rebuild(&self, blocks: &[Block]) -> Result<RebuildReport, CaseIndexError>
    // Full reindex: indexed, skipped, errors counts

    pub fn verify_count(&self, expected: u64) -> Result<bool, CaseIndexError>
    pub fn verify_hash(&self, block_index: u64, expected_hash: &str) -> Result<bool, CaseIndexError>
}

pub struct CaseIndexRow {
    pub block_index: u64,
    pub block_hash: String,
    pub chain: String,
    pub case_type: String,
    pub full_json: String,
    pub entry: CaseEntry,  // parsed from full_json
}
```

### The 8 Grammatical Cases

| Case         | Variant                           | Key Fields           |
| ------------ | --------------------------------- | -------------------- |
| Nominative   | `entity`, `action`, `timestamp`   | Who did what         |
| Genitive     | `owner`, `possessed`              | Ownership relations  |
| Dative       | `giver`, `recipient`, `object`    | Giving to whom       |
| Accusative   | `subject`, `verb`, `object`       | Action on object     |
| Instrumental | `actor`, `instrument`, `target`   | Tool used for action |
| Locative     | `entity`, `location`              | Entity at location   |
| Ablative     | `entity`, `origin`, `destination` | Movement from/to     |
| Vocative     | `invoker`, `invocation`, `target` | Named invocation     |

---

## 7. memphis-napi — The Node.js Bridge

**Path:** `crates/memphis-napi/src/lib.rs`

> **Depends on:** All of the above crates

### Exported Functions (#[napi])

```rust
// Chain operations
#[napi] pub fn chain_validate(block_json: String, prev_json: Option<String>) -> String
#[napi] pub fn chain_append(chain_json: String, block_json: String) -> String
#[napi] pub fn chain_query(chain_json: String, contains: Option<String>, tag: Option<String>) -> String

// Vault operations (new API — JsVault struct passing)
#[napi] pub fn vault_init(passphrase: String) -> JsVault
#[napi] pub fn vault_init_full(passphrase: String, qa_question: String, qa_answer: String) -> JsVaultInitResult
// JsVaultInitResult = { vault: JsVault, did: String, qa_question: String }
#[napi] pub fn vault_store(vault: JsVault, key: String, plaintext: Buffer) -> JsVaultEntry
#[napi] pub fn vault_retrieve(vault: JsVault, entry: JsVaultEntry) -> Buffer

// Vault operations (legacy API — JSON string envelope)
#[napi] pub fn vault_init_json(request_json: String) -> String
#[napi] pub fn vault_encrypt(key: String, plaintext: String) -> String    // zero-salt Argon2id, legacy v1
#[napi] pub fn vault_decrypt(entry_json: String) -> String                // zero-salt Argon2id, legacy v1

// Embed operations
#[napi] pub fn embed_store(id: String, text: String, tags_json: Option<String>) -> String
#[napi] pub fn embed_search(query: String, top_k: Option<u32>, tags_json: Option<String>) -> String
#[napi] pub fn embed_search_tuned(query: String, top_k: Option<u32>, tags_json: Option<String>) -> String
#[napi] pub fn embed_reset() -> String

// Soul / Loop operations
#[napi] pub fn soul_loop_step(state_json: String, action_json: String, limits_json: Option<String>) -> String
#[napi] pub fn soul_replay(chain_name: String, blocks_json: String) -> String

// Case operations
#[napi] pub fn case_append(chain_json: String, entry_json: String, index_db_path: String) -> String
#[napi] pub fn case_query(query_json: String, index_db_path: String) -> String
#[napi] pub fn case_rebuild(blocks_json: String, index_db_path: String) -> String
```

### All NAPI functions return JSON strings

```rust
#[derive(Serialize)]
struct ApiResult<T: Serialize> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

fn ok<T: Serialize>(data: T) -> String { serde_json::to_string(&ApiResult { ok: true, data: Some(data), error: None }) }
fn err(msg: impl Into<String>) -> String { serde_json::to_string(&ApiResult { ok: false, data: None, error: Some(msg.into()) }) }
```

### Embed Pipeline Singleton

```rust
static EMBED_PIPELINE: OnceLock<Mutex<EmbedPipeline>> = OnceLock::new();
// Initialized lazily on first embed_* call from env vars:
// RUST_EMBED_MODE, RUST_EMBED_DIM, RUST_EMBED_PERSIST_ENABLED, etc.
```

---

## 8. Call Flows

### flow 1: embed_search via NAPI

```
TS runtime (embed_search call)
    │
    ▼
memphis-napi::embed_search()
    │ reads env: RUST_EMBED_MODE, RUST_EMBED_*
    ▼
memphis-embed::EmbedPipeline::search_with_tags()
    │
    ├──► memphis-core: (not directly — uses cached vectors)
    │
    └──► VectorStore (in-memory HNSW-like)
            │
            └──► Optional: ChainRef metadata enrichment

Response: JSON string back through NAPI
```

### flow 2: case_append via NAPI

```
TS runtime (case_append call)
    │
    ▼
memphis-napi::case_append()
    │ parses chain_json → Vec<Block>
    │ parses entry_json → CaseEntry
    │ validates CaseEntry::validate()
    │
    ├──► memphis-core: Block, BlockData, BlockType::Case
    │         compute_hash(&block)
    │         validate_block(&block, prev)
    │         maybe_sign_unsigned_block()
    │
    └──► memphis-case-index: CaseIndex::open()
              │
              CaseIndex::index_block(&block)
              │  • filters: BlockType::Case only
              │  • parses: CaseEntry::from_block_content()
              │  • extracts denormalized fields
              │  • INSERT INTO case_entries (...)
              │
Response: JSON { appended, indexed, length, chain }
```

### flow 3: soul_loop_step via NAPI

```
TS runtime (soul_loop_step call)
    │
    ▼
memphis-napi::soul_loop_step()
    │ parses state_json → LoopState
    │ parses action_json → LoopAction
    │ parses limits_json → LoopLimits (or default)
    │
    ▼
memphis-core::LoopState::apply(&action, &limits)
    │
    │ State machine: increments steps, tool_calls, wait_ms, errors
    │ Checks: max_steps, max_tool_calls, max_wait_ms, max_errors
    │ Transitions: ToolCall → increment | Wait → accumulate | Error → halt
    │
Response: JSON { applied, state: LoopState, (if failed: reason) }
```

### flow 4: vault_encrypt via NAPI (legacy path)

```
TS runtime (vault_encrypt call)
    │
    ▼
memphis-napi::vault_encrypt()
    │ builds VaultConfig { pepper: key, iterations: 100_000, memory: 64 }
    │
    ▼
memphis-vault::derive_master_key()
    │ Argon2id with zero salt (legacy v1)
    │
    ▼
memphis-vault::encrypt_entry()
    │ AES-256-GCM: random 12-byte nonce
    │ encrypts plaintext → ciphertext + tag
    │ returns VaultEntry { id, key:"legacy", ciphertext, nonce, tag }
    │
Response: JSON { ok, data: VaultEntry }
```

---

## 9. Verification of User's Diagram

**User's diagram was mostly correct. Corrections:**

| Claim                                              | Status     | Correction                                             |
| -------------------------------------------------- | ---------- | ------------------------------------------------------ |
| memphis-vault standalone (no deps on other crates) | ✅ Correct | Confirmed — no production deps on any memphis-\* crate |
| memphis-embed depends on memphis-core              | ✅ Correct | Uses `MemoryChain` from `chain.rs`                     |
| memphis-case-index depends on memphis-core         | ✅ Correct | Uses `Block`, `BlockType`, `CaseEntry`, `CaseQuery`    |
| memphis-core has no internal deps                  | ✅ Correct | Self-contained with only external crates               |
| memphis-napi aggregates all crates                 | ✅ Correct | Imports all of them                                    |
| Embed → ChainRef uses memphis-core types           | ✅ Correct | `MemoryChain`, `Block`                                 |
| Case → Block, CaseEntry, CaseQuery from core       | ✅ Correct | Confirmed                                              |
| Vault independence                                 | ✅ Correct | Standalone                                             |

**One nuance added:** The `memphis-vault` dev-dependencies do pull in `memphis-core` and `memphis-embed` (for testing), but these are **dev-only** and not present in production builds.

---

## 10. Environment Variable Configuration (NAPI)

All env vars read by `memphis-napi` at runtime:

| Variable                         | Purpose                                      | Default                          |
| -------------------------------- | -------------------------------------------- | -------------------------------- |
| `RUST_CHAIN_REQUIRE_SIGNATURES`  | Reject unsigned blocks                       | `false`                          |
| `RUST_CHAIN_SIGNER_KEY_HEX`      | Ed25519 hex key for auto-signing             | _(none)_                         |
| `RUST_CHAIN_SIGNER_ALLOWLIST`    | Comma-separated allowed signers              | _(none)_                         |
| `RUST_EMBED_MODE`                | `local`, `ollama`, `openai-compatible`, etc. | `local`                          |
| `RUST_EMBED_DIM`                 | Embedding dimension                          | `32`                             |
| `RUST_EMBED_MAX_TEXT_BYTES`      | Max text size                                | `4096`                           |
| `RUST_EMBED_PROVIDER_URL`        | Embedding provider endpoint                  | _(none)_                         |
| `RUST_EMBED_PROVIDER_API_KEY`    | API key for provider                         | _(none)_                         |
| `RUST_EMBED_PROVIDER_MODEL`      | Model name                                   | _(none)_                         |
| `RUST_EMBED_PROVIDER_TIMEOUT_MS` | Provider timeout                             | `8000`                           |
| `RUST_EMBED_PERSIST_ENABLED`     | Enable disk persistence                      | `false`                          |
| `RUST_EMBED_PERSIST_PATH`        | Persistence file path                        | `~/.memphis/embed/index-v1.json` |

---

## 11. TypeScript → Rust Bridge (NAPI Communication)

**Key files:**

- `src/infra/storage/napi-contract.ts` — bridge loading + alias resolution
- `src/infra/storage/chain-adapter.ts` — top-level router (rust-napi vs ts-legacy)
- `src/infra/storage/rust-chain-adapter.ts` — NapiChainAdapter (chain + embed + soul)
- `src/infra/storage/rust-vault-adapter.ts` — vault with new + legacy contracts
- `src/infra/storage/rust-embed-adapter.ts` — embed-only adapter with LRU cache
- `src/infra/storage/case-chain-adapter.ts` — CaseChainAdapter (append/query/rebuild)

### Bridge Loading

```ts
// napi-contract.ts
import { createRequire } from 'node:module';

export function loadBridgeModule(path: string): BridgeModule | null {
  const req = createRequire(`${process.cwd()}/`);
  return req(path); // dynamic require of .node/.so
}
```

Default path: `RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi'`

### Alias Resolution

Rust exports snake_case (e.g. `chain_append`), but TS adapters accept both snake_case and camelCase aliases. `resolveBridgeContract` tries all candidates and uses the first match:

```ts
// rust-chain-adapter.ts
const CHAIN_BRIDGE_ALIASES = {
  chain_append: ['chain_append', 'chainAppend'],
  chain_validate: ['chain_validate', 'chainValidate'],
  embed_store: ['embed_store', 'embedStore'],
  embed_search: ['embed_search', 'embedSearch'],
  soul_loop_step: ['soul_loop_step', 'soulLoopStep'],
} satisfies BridgeAliasMap<...>;
```

### JSON Envelope Pattern

Every NAPI function returns a JSON string envelope. All TS adapters parse it the same way:

```ts
// rust-chain-adapter.ts
interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function parseEnvelope<T>(raw: string, fnName: string): T {
  const out = JSON.parse(raw) as BridgeEnvelope<T>;
  if (!out.ok) throw new Error(`${fnName}: ${out.error}`);
  if (out.data === undefined) throw new Error(`${fnName}: empty data`);
  return out.data;
}
```

### Feature Flag: RUST_CHAIN_ENABLED

```ts
// chain-adapter.ts
export function getChainAdapterStatus(rawEnv): ChainAdapterStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED, false);
  if (!rustEnabled) {
    return { backend: 'ts-legacy', rustEnabled, ... };
  }
  // try to load rust bridge...
  return { backend: 'rust-napi', rustEnabled, ... };
}
```

When `RUST_CHAIN_ENABLED=false` or bridge fails to load:

- Chain: pure-TS fallback — writes JSON block files to `~/.memphis/chains/<chain>/<index>.json` with `.append.lock`
- Vault: **no pure-TS fallback** — `getBridgeOrThrow` throws if bridge unavailable
- Embed: no pure-TS fallback in current implementation
- Case: `appendViaTs` / `queryViaTs` — pure-TS block file operations (no SQLite dependency for basic append/query)

### Adapter Architecture

```
TypeScript Runtime
│
├── chain-adapter.ts          ← routes by RUST_CHAIN_ENABLED
│       │
│       ├── backend: 'ts-legacy'
│       │       └── writes JSON files with file-based locking
│       │
│       └── backend: 'rust-napi'
│               └── NapiChainAdapter (rust-chain-adapter.ts)
│                       │
│                       ├── chain_append / chain_validate / chain_query
│                       ├── embed_store / embed_search (unified bridge)
│                       └── soul_loop_step / soul_replay
│
├── rust-vault-adapter.ts    ← vaultInit / vaultEncrypt / vaultDecrypt
│       │
│       ├── NEW contract: vault_init_full / vault_store / vault_retrieve
│       │       (returns JsVault struct, full DID + 2FA support)
│       │
│       └── LEGACY contract: vault_init_json / vault_encrypt / vault_decrypt
│               (zero-salt Argon2id, JSON string envelope)
│       └── Adapter tries NEW first, falls back to LEGACY
│
├── rust-embed-adapter.ts    ← embedStore / embedSearch / embedSearchTuned
│       │
│       ├── LRU cache (128 entries, configurable TTL, 15s default)
│       ├── Falls back to embed_search if embed_search_tuned unavailable
│       └── Metrics: recordEmbedCacheHit / recordEmbedCacheMiss
│
└── case-chain-adapter.ts    ← CaseChainAdapter.appendCaseEntry / queryCases
        │
        ├── appendViaRust → case_append → CaseIndex::index_block
        ├── appendViaTs → pure-TS block file write
        ├── queryViaRust → case_query → SQLite CaseIndex
        ├── queryViaTs → scan chain block files, filter in-process
        └── reconcileIfNeeded() → rebuilds SQLite from chain files at startup
```

### Vault: New vs. Legacy Contract

The vault adapter has **two** bridge contracts because the Rust side was extended:

```ts
// NEW contract (vault_init_full returns JsVault struct directly)
const NEW_VAULT_BRIDGE_ALIASES = {
  vault_init_full: ['vault_init_full', 'vaultInitFull'], // returns JsVault
  vault_store: ['vault_store', 'vaultStore'], // vault + key + plaintext → JsVaultEntry
  vault_retrieve: ['vault_retrieve', 'vaultRetrieve'], // vault + JsVaultEntry → plaintext buffer
};

// LEGACY contract (returns JSON strings via envelope)
const LEGACY_VAULT_BRIDGE_ALIASES = {
  vault_init_json: ['vault_init_json', 'vault_init', 'vaultInitJson'],
  vault_encrypt: ['vault_encrypt', 'vaultEncrypt'],
  vault_decrypt: ['vault_decrypt', 'vaultDecrypt'],
};
```

JS vault state is persisted to `MEMPHIS_VAULT_STATE_PATH ?? './data/vault-state.json'`:

- **v1**: plaintext base64 master key (legacy, transparent upgrade to v2)
- **v2**: AES-256-GCM encrypted master key, pepper from `MEMPHIS_VAULT_PEPPER` (min 12 chars)

### Env Vars for TS↔Rust Bridge

| Variable                          | Where Read                                        | Effect                                                 |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| `RUST_CHAIN_ENABLED`              | chain-adapter, rust-vault, rust-embed, case-chain | Enable Rust NAPI backend                               |
| `RUST_CHAIN_BRIDGE_PATH`          | All adapters                                      | Path to `.node/.so` (default: `./crates/memphis-napi`) |
| `MEMPHIS_VAULT_PEPPER`            | rust-vault-adapter                                | Pepper for vault state encryption (min 12 chars)       |
| `MEMPHIS_VAULT_STATE_PATH`        | rust-vault-adapter                                | Path to vault state file                               |
| `EMBED_CACHE_TTL_SECONDS`         | rust-embed-adapter                                | Cache TTL (default: 15s)                               |
| `MEMPHIS_STRICT_CHAIN_VALIDATION` | chain-adapter.ts                                  | Hash strictness (default: `true`)                      |

### Call Flow: appendBlock (rust-napi path)

```
appendBlock(chainName, data)
    │
    ▼
getChainAdapterStatus() → backend: 'rust-napi'
    │
    ▼
new NapiChainAdapter(rawEnv).appendBlock(chain, data)
    │
    ├── readChainBlocks(chain)           ← read from ~/.memphis/chains/<chain>/
    ├── toNapiBlock()                    ← build block, SHA-256 hash in TS
    ├── bridge.chain_append(chainJson, blockJson)
    │       │
    │       └──► NAPI: chain_append(chain_json, block_json)
    │               │
    │               ├──► memphis-core: validate_block / maybe_sign
    │               ├──► blocks.push(block)
    │               │
    │               ◄──── JSON { ok, data: { appended, length, chain } }
    │
    ├── writeBlock(chain, appended)      ← write ~/.memphis/chains/<chain>/<index>.json
    │
    ▼
AppendBlockResult { index, hash, chain, timestamp }
```

### Call Flow: embedSearch with cache

```
embedSearch(query, topK=5)
    │
    ▼
getFromCache(cacheKey) → hit? → return cached
    │
    ▼ miss
bridge.embed_search(query, topK, tagsJson)
    │
    └──► NAPI: embed_search(query, topK)
            │
            ├──► memphis-embed: EmbedPipeline::search_with_tags()
            │
            ◄──── JSON { ok, data: { query, count, hits: [...] } }
    │
    ▼
setToCache(cacheKey, result, ttlMs)
return result
```

### Verification of User's TS-Bridge Summary

| Claim                                             | Status                                          |
| ------------------------------------------------- | ----------------------------------------------- |
| Dynamic loading via `createRequire`               | ✅ Confirmed — `napi-contract.ts`               |
| Alias resolution (snake_case ↔ camelCase)         | ✅ Confirmed — all adapters                     |
| Four adapter layers (chain, vault, embed, case)   | ✅ Confirmed                                    |
| `RUST_CHAIN_ENABLED` feature flag                 | ✅ Confirmed — all adapters check it            |
| JSON round-trips (all NAPI functions return JSON) | ✅ Confirmed — `parseEnvelope` in every adapter |
| `RUST_CHAIN_BRIDGE_PATH` override                 | ✅ Confirmed                                    |
| `RUST_EMBED_MODE` env var                         | ✅ Confirmed — read in Rust NAPI                |
| `MEMPHIS_VAULT_PEPPER` for vault state            | ✅ Confirmed — `rust-vault-adapter.ts`          |
| `RUST_CHAIN_SIGNER_KEY_HEX` for auto-sign         | ✅ Confirmed — read in Rust NAPI                |
| `vault_encrypt` uses zero-salt Argon2id (legacy)  | ✅ Confirmed — `lib.rs:357-364`                 |

**One nuance added:** The vault adapter has **two separate bridge contracts** (new + legacy), not just one. The new contract (`vault_init_full`) returns a native `JsVault` struct, while the legacy contract returns JSON envelopes. Both are aliased for snake_case/camelCase compatibility.
