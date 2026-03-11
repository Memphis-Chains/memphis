# MEMPHIS v4 — CODELINE & BUILDER'S BLUEPRINT

## From Current Alpha → Workable "Hatch Your Terminal Toy"

**Date:** 2026-03-08
**Decision:** Complete refactor. Rust core. pi-tui (Nexus). Simple install.
**Philosophy:** Partner, not tool. Local-first. Sovereign memory.

---

## TABLE OF CONTENTS

1. Architecture Overview
2. Codeline (directory structure for coders)
3. Rust Core spec
4. TypeScript Shell spec
5. Vault & SSI spec
6. TUI (pi-tui Nexus) spec
7. LLM Provider System spec
8. Install & Onboarding spec
9. What to salvage from current codebase
10. Phased Roadmap (8 phases)
11. Decentralized LLM options
12. Coder Instructions (how to start building)

---

## 1. ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────┐
│                    USER LAYER                            │
│  CLI (Commander.js) │ TUI (pi-tui Nexus) │ MCP Server   │
├─────────────────────────────────────────────────────────┤
│                 TYPESCRIPT SHELL                         │
│  Ask Engine │ Decision Engine │ Intelligence │ Bridges    │
│  Providers (LLM factory) │ Onboarding │ Config           │
├─────────────────────────────────────────────────────────┤
│               NAPI-RS BRIDGE (FFI)                       │
│  memphis_core::chain  → chain_*() functions              │
│  memphis_core::vault  → vault_*() functions              │
│  memphis_core::embed  → embed_*() functions              │
├─────────────────────────────────────────────────────────┤
│                    RUST CORE                              │
│  Chain Engine │ Vault (AES-256-GCM + SSI) │ Embed Store  │
│  SOUL Validator │ Hash (SHA-256) │ Key Derivation         │
│  Block Schema │ Query Index │ Export/Import                │
└─────────────────────────────────────────────────────────┘
```

**Rule:** All data touching disk or crypto goes through Rust.
All UI, LLM, network goes through TypeScript.
napi-rs is the bridge — zero unsafe JS touches raw chain data.

---

## 2. CODELINE (directory structure)

```
memphis/
├── Cargo.toml                    # Workspace root
├── package.json                  # TS shell
├── tsconfig.json
├── vitest.config.ts
├── SOUL.md                       # Immutable block rules
├── README.md
├── LICENSE                       # MIT
│
├── crates/                       # ═══ RUST CORE ═══
│   ├── memphis-core/             # Chain + Block + SOUL
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs            # pub mod chain, block, soul, query
│   │       ├── block.rs          # Block struct, BlockData, types
│   │       ├── chain.rs          # MemoryChain, append, validate, iterate
│   │       ├── soul.rs           # SOUL validation rules
│   │       ├── query.rs          # Index, search, filter by tag/chain/date
│   │       ├── hash.rs           # SHA-256 (ring or sha2 crate)
│   │       ├── export.rs         # JSON export/import, migration
│   │       └── error.rs          # MemphisError enum
│   │
│   ├── memphis-vault/            # Encrypted vault + SSI
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── vault.rs          # AES-256-GCM encrypt/decrypt
│   │       ├── keyring.rs        # Key derivation (Argon2id), master key
│   │       ├── ssi.rs            # DID generation, credential schema
│   │       ├── two_factor.rs     # Q&A 2FA + strong passphrase
│   │       └── init.rs           # First-time vault setup flow
│   │
│   ├── memphis-embed/            # Vector store (optional)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── store.rs          # In-memory + disk vector index
│   │       ├── similarity.rs     # Cosine similarity
│   │       └── cache.rs          # Embedding cache with invalidation
│   │
│   └── memphis-napi/             # ═══ NAPI-RS BRIDGE ═══
│       ├── Cargo.toml            # [lib] crate-type = ["cdylib"]
│       ├── build.rs
│       └── src/
│           ├── lib.rs            # #[napi] exports
│           ├── chain_bridge.rs   # chain_append, chain_validate, chain_query
│           ├── vault_bridge.rs   # vault_init, vault_store, vault_get
│           └── embed_bridge.rs   # embed_store, embed_search
│
├── src/                          # ═══ TYPESCRIPT SHELL ═══
│   ├── cli/
│   │   ├── index.ts              # Commander.js entry point
│   │   └── commands/
│   │       ├── init.ts           # memphis init (→ onboarding)
│   │       ├── journal.ts        # memphis journal "..."
│   │       ├── ask.ts            # memphis ask "..." (LLM + recall)
│   │       ├── recall.ts         # memphis recall "keyword"
│   │       ├── status.ts         # memphis status
│   │       ├── decide.ts         # memphis decide "title" "choice"
│   │       ├── vault.ts          # memphis vault init/add/get/list
│   │       ├── tui.ts            # memphis tui (launches Nexus)
│   │       ├── doctor.ts         # memphis doctor
│   │       ├── config.ts         # memphis config set/get/list
│   │       └── provider.ts       # memphis provider add/list/test
│   │
│   ├── tui/                      # ═══ PI-TUI NEXUS ═══
│   │   ├── index.ts              # TUI entry point
│   │   ├── app.ts                # Main app layout
│   │   ├── theme.ts              # Dark/light themes
│   │   ├── keybinds.ts           # Keyboard shortcuts
│   │   ├── screens/
│   │   │   ├── dashboard.ts      # Home screen: status + recent
│   │   │   ├── chat.ts           # LLM chat (ask mode)
│   │   │   ├── journal.ts        # Journal browser + add
│   │   │   ├── decisions.ts      # Decision timeline
│   │   │   ├── vault.ts          # Vault manager
│   │   │   ├── providers.ts      # LLM provider config
│   │   │   └── settings.ts       # General settings
│   │   └── widgets/
│   │       ├── chain-viewer.ts   # Block browser
│   │       ├── search-bar.ts     # Semantic search
│   │       └── status-bar.ts     # Bottom bar: provider, chain health
│   │
│   ├── core/
│   │   ├── ask.ts                # Ask engine (LLM + recall + SOUL prompt)
│   │   ├── recall.ts             # Recall (keyword + semantic)
│   │   ├── status.ts             # System status builder
│   │   ├── onboarding.ts         # First-run interactive setup
│   │   ├── decision-detector.ts  # Auto-detect decisions in text
│   │   └── planner.ts            # Daily/weekly planning
│   │
│   ├── providers/
│   │   ├── index.ts              # Provider interface + types
│   │   ├── factory.ts            # Provider factory (priority chain)
│   │   ├── ollama.ts             # Ollama (local, always available)
│   │   ├── openai.ts             # OpenAI / GPT
│   │   ├── openrouter.ts         # OpenRouter (multi-model)
│   │   ├── anthropic.ts          # Anthropic / Claude
│   │   ├── deepseek.ts           # DeepSeek (open source)
│   │   ├── custom.ts             # Custom OpenAI-compatible endpoint
│   │   └── fallback.ts           # Fallback chain logic
│   │
│   ├── bridges/
│   │   ├── mcp-server.ts         # Memphis as MCP tool provider
│   │   ├── mcp-client.ts         # Memphis consuming external MCP tools
│   │   └── tool-router.ts        # Route requests to best tool/provider
│   │
│   ├── intelligence/             # (salvage from current)
│   │   ├── event-detector.ts
│   │   ├── categorizer.ts
│   │   ├── suggestions.ts
│   │   └── summarizer.ts
│   │
│   ├── decision/                 # (salvage from current)
│   │   ├── schema.ts
│   │   ├── lifecycle.ts
│   │   ├── inference-engine.ts
│   │   └── prediction-engine.ts
│   │
│   ├── config/
│   │   ├── defaults.ts           # Default paths, settings
│   │   └── loader.ts             # YAML config loader
│   │
│   └── utils/
│       ├── logger.ts             # Structured logging (chalk)
│       └── errors.ts             # Error types
│
├── tests/
│   ├── rust/                     # Rust unit tests (in crates)
│   ├── unit/                     # TS unit tests
│   ├── integration/              # Cross-layer tests
│   └── e2e/                      # Full workflow tests
│
├── scripts/
│   ├── install.sh                # curl installer
│   ├── smoke-test.sh             # Quick health check
│   └── release.sh                # Build + tag + publish
│
└── docs/
    ├── ARCHITECTURE.md
    ├── QUICKSTART.md
    ├── PROVIDERS.md              # How to add LLM providers
    ├── VAULT.md                  # Vault + SSI guide
    └── CONTRIBUTING.md
```

---

## 3. RUST CORE SPEC

### 3.1 Block (crates/memphis-core/src/block.rs)

```rust
use serde::{Serialize, Deserialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockType {
    Journal, Ask, Decision, Vault, Credential,
    System, Summary, Log, Share, Trade, Task,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockData {
    #[serde(rename = "type")]
    pub block_type: BlockType,
    pub content: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_used: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_refs: Option<Vec<ContextRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<SourceRef>,
    /// Encrypted payload (vault blocks only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iv: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub index: u64,
    pub timestamp: String,       // ISO 8601
    pub chain: String,
    pub data: BlockData,
    pub prev_hash: String,       // 64 hex chars
    pub hash: String,            // SHA-256
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextRef {
    pub chain: String,
    pub index: u64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub chain: String,
    pub index: u64,
    pub hash: String,
}
```

### 3.2 Chain (crates/memphis-core/src/chain.rs)

```rust
use crate::{block::{Block, BlockData}, hash::compute_hash, soul::validate_block};
use crate::error::MemphisError;
use std::path::PathBuf;

pub struct MemoryChain {
    name: String,
    blocks: Vec<Block>,
    path: PathBuf,
}

impl MemoryChain {
    /// Load chain from disk (JSON files: 000000.json, 000001.json, ...)
    pub fn load(name: &str, base_path: &PathBuf) -> Result<Self, MemphisError>;

    /// Append new block — validates SOUL rules, computes hash, persists
    pub fn append(&mut self, data: BlockData) -> Result<&Block, MemphisError>;

    /// Validate entire chain integrity
    pub fn validate(&self) -> Result<(), Vec<MemphisError>>;

    /// Query blocks by filter
    pub fn query(&self, filter: &QueryFilter) -> Vec<&Block>;

    /// Get last N blocks
    pub fn tail(&self, n: usize) -> Vec<&Block>;

    /// Get block by index
    pub fn get(&self, index: u64) -> Option<&Block>;

    /// Chain length
    pub fn len(&self) -> usize;

    /// Export chain to single JSON array
    pub fn export_json(&self) -> Result<String, MemphisError>;

    /// Import from JSON (migration from old TS chains)
    pub fn import_json(name: &str, json: &str, path: &PathBuf)
        -> Result<Self, MemphisError>;
}
```

### 3.3 SOUL Validator (crates/memphis-core/src/soul.rs)

```rust
pub fn validate_block(block: &Block, prev: Option<&Block>) -> Result<(), Vec<String>> {
    let mut errors = vec![];

    // 1. Hash integrity
    let expected = compute_hash(block);
    if block.hash != expected {
        errors.push(format!("hash mismatch: expected {expected}"));
    }

    // 2. Chain link
    match prev {
        None => {
            if block.prev_hash != "0".repeat(64) {
                errors.push("genesis must have zero prev_hash".into());
            }
            if block.index != 0 {
                errors.push("genesis must have index 0".into());
            }
        }
        Some(p) => {
            if block.prev_hash != p.hash {
                errors.push("prev_hash doesn't match previous block".into());
            }
            if block.index != p.index + 1 {
                errors.push("index not sequential".into());
            }
            if block.timestamp < p.timestamp {
                errors.push("timestamp before previous block".into());
            }
        }
    }

    // 3. Content validation
    if block.data.content.is_empty() {
        errors.push("content must not be empty".into());
    }

    if errors.is_empty() { Ok(()) } else { Err(errors) }
}
```

### 3.4 Dependencies (Cargo.toml)

```toml
[workspace]
members = ["crates/*"]

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
aes-gcm = "0.10"
argon2 = "0.5"
chrono = { version = "0.4", features = ["serde"] }
rand = "0.8"
thiserror = "2"

# napi bridge
[dependencies.napi]
version = "3"
features = ["napi9", "serde-json"]
[dependencies.napi-derive]
version = "3"
```

---

## 4. VAULT & SSI SPEC

### 4.1 Init flow (first time)

```
$ memphis init

🧠 Memphis — First Time Setup

Step 1/4: Create your vault passphrase
  This protects all your encrypted data.
  Requirements: min 16 chars, 1 upper, 1 number, 1 special

  Passphrase: ••••••••••••••••••••
  Confirm:    ••••••••••••••••••••

Step 2/4: Set recovery question
  Question: What was the name of your first pet?
  Answer:   ••••••••••••

  ⚠️  This is your 2FA recovery. Store it safely.

Step 3/4: Generate your identity (DID)
  ✓ did:memphis:z6Mkf5rGMoatrSj1f... generated
  ✓ Stored in vault (encrypted)

Step 4/4: Choose default LLM provider
  ● Ollama (local, free — recommended)
  ○ OpenAI (API key needed)
  ○ OpenRouter (multi-model, API key needed)
  ○ Anthropic (API key needed)
  ○ DeepSeek (open source, API or local)
  ○ Custom endpoint (OpenAI-compatible URL)
  ○ Skip — I'll configure later

✅ Memphis ready. Try: memphis journal "Hello, Memphis!"
```

### 4.2 Key derivation

```rust
// Argon2id (memory-hard, GPU-resistant)
pub fn derive_master_key(
    passphrase: &str,
    salt: &[u8; 32],     // random, stored in vault header
) -> [u8; 32] {
    let params = argon2::Params::new(65536, 3, 4, Some(32)).unwrap();
    let argon2 = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        params,
    );
    let mut key = [0u8; 32];
    argon2.hash_password_into(
        passphrase.as_bytes(), salt, &mut key
    ).unwrap();
    key
}

// 2FA: Q&A is hashed and XOR'd with master key for final vault key
pub fn derive_vault_key(
    master_key: &[u8; 32],
    qa_answer: &str,
) -> [u8; 32] {
    let qa_hash = sha256(qa_answer.as_bytes());
    let mut vault_key = [0u8; 32];
    for i in 0..32 {
        vault_key[i] = master_key[i] ^ qa_hash[i];
    }
    vault_key
}
```

### 4.3 Vault file format

```json
{
  "version": 1,
  "salt": "hex...",
  "qa_hash_check": "hex...",
  "did": {
    "id": "did:memphis:z6Mkf5rGMoatrSj1f...",
    "created": "2026-03-08T...",
    "encrypted_private_key": "base64..."
  },
  "entries": {
    "openai_api_key": {
      "encrypted": "base64...",
      "iv": "hex...",
      "created": "2026-03-08T...",
      "tags": ["provider", "api-key"]
    }
  }
}
```

### 4.4 Future-proof for crypto

Vault key structure is designed so that adding blockchain signing later requires ONLY:

- New crate `memphis-crypto` with wallet generation
- Extend DID to support `did:memphis:chain:...` format
- Add `sign()` / `verify()` to vault bridge
- **Zero changes** to existing vault, chain, or TUI code

---

## 5. TUI (PI-TUI NEXUS) SPEC

### 5.1 Layout

```
┌─ Memphis Nexus ──────────────────────────────────────────┐
│ 📊 Dashboard │ 💬 Chat │ 📓 Journal │ ⚡ Decide │ 🔐 Vault│
├──────────────────────────────────────────────────────────┤
│                                                          │
│  [Main content area — changes per screen]                │
│                                                          │
│                                                          │
│                                                          │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ 🟢 Ollama:qwen2.5 │ chains:5 │ blocks:847 │ vault:locked│
└──────────────────────────────────────────────────────────┘
  Tab/1-5: switch │ /: search │ ?: help │ q: quit
```

### 5.2 Screens

| Key | Screen    | What it does                                                     |
| --- | --------- | ---------------------------------------------------------------- |
| 1   | Dashboard | Chain stats, recent blocks, health indicators, suggestions       |
| 2   | Chat      | Interactive `memphis ask` with history, context refs, confidence |
| 3   | Journal   | Browse/add journal entries, tag filter, date range               |
| 4   | Decide    | Decision timeline, inferred decisions, lifecycle view            |
| 5   | Vault     | Manage secrets, API keys, DID info                               |
| 6   | Providers | Add/remove/test LLM providers, set priority                      |
| 7   | Settings  | Config editor (YAML), theme, keybinds                            |

### 5.3 Provider config in TUI

```
┌─ LLM Providers ─────────────────────────────────────────┐
│                                                          │
│  Priority  Provider        Model              Status     │
│  ────────────────────────────────────────────────────    │
│  1. ●      Ollama          qwen2.5-coder:3b   🟢 OK     │
│  2. ○      OpenRouter      claude-3.5-sonnet   🟡 key?   │
│  3. ○      DeepSeek        deepseek-v3.2       🔴 off    │
│                                                          │
│  [a] Add provider  [d] Delete  [t] Test  [↑↓] Reorder   │
│                                                          │
│  ─── Add Provider ───                                    │
│  Name: OpenAI                                            │
│  API Key: sk-••••••••••••                                │
│  Save to vault? [Y/n]                                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 6. LLM PROVIDER SYSTEM

### 6.1 Supported providers

| Provider        | Type        | Config needed         | Decentralized? |
| --------------- | ----------- | --------------------- | -------------- |
| **Ollama**      | Local       | Just install Ollama   | ✅ Fully local |
| **llama.cpp**   | Local       | Binary + model file   | ✅ Fully local |
| **OpenAI**      | Cloud API   | API key               | ❌             |
| **Anthropic**   | Cloud API   | API key               | ❌             |
| **OpenRouter**  | Cloud API   | API key (multi-model) | ❌             |
| **DeepSeek**    | Cloud/Local | API key or self-host  | 🟡             |
| **Together.ai** | Cloud API   | API key (open models) | 🟡             |
| **Custom**      | Any         | OpenAI-compatible URL | Depends        |

### 6.2 Decentralized LLM options (no IPFS/Pinata needed)

Instead of IPFS for model distribution, use the existing ecosystem:

- **Ollama** — already does model pull/push from registry, local-first
- **Hugging Face** — model hub, download weights directly
- **QVAC Fabric LLM** (Tether) — edge-first inference, Apache 2.0 open source
- **Decentralized inference** (wavefy/decentralized-llm-inference) — P2P model splitting across devices

Memphis doesn't need to reinvent model distribution. It needs to be a **good consumer** of these systems.

### 6.3 Provider interface

```typescript
export interface Provider {
  name: string;
  isConfigured(): boolean;
  isAvailable(): Promise<boolean>; // health check
  chat(messages: Message[], opts?: ChatOptions): Promise<ChatResponse>;
  models(): Promise<string[]>; // list available models
  defaultModel(): string;
}

// Factory resolves by priority: explicit → config → env → Ollama fallback
export async function resolveProvider(opts?: ProviderOptions): Promise<ResolvedProvider>;
```

---

## 7. INSTALL & ONBOARDING

### 7.1 Install methods

```bash
# Method 1: npm (requires Node.js)
npm install -g @memphis-ai/memphis

# Method 2: curl installer (downloads pre-built binary)
curl -fsSL https://raw.githubusercontent.com/elathoxu-crypto/memphis/master/scripts/install.sh | sh

# Method 3: cargo (builds from source, gets Rust core)
cargo install memphis-cli

# Method 4: from source
git clone https://github.com/elathoxu-crypto/memphis.git
cd memphis
npm install && npm run build:rust && npm run build
npm link
```

### 7.2 First run

After install, first `memphis` command triggers onboarding:

1. Create vault passphrase (strong, validated)
2. Set Q&A 2FA recovery
3. Generate DID identity
4. Choose LLM provider (with test)
5. Create genesis blocks
6. Show quick tutorial

---

## 8. WHAT TO SALVAGE FROM CURRENT CODEBASE

### ✅ KEEP (copy to new structure)

| Current file                      | New location                    | Why                                            |
| --------------------------------- | ------------------------------- | ---------------------------------------------- |
| `src/core/ask.ts` (947 LOC)       | `src/core/ask.ts`               | Mature. SOUL prompt, external mode, confidence |
| `src/core/recall.ts`              | `src/core/recall.ts`            | Works                                          |
| `src/core/status.ts`              | `src/core/status.ts`            | Works                                          |
| `src/core/decision-detector.ts`   | `src/core/decision-detector.ts` | Recently hardened                              |
| `src/core/planner.ts`             | `src/core/planner.ts`           | Works                                          |
| `src/decision/*` (3461 LOC)       | `src/decision/*`                | Complete engine                                |
| `src/intelligence/*` (3462 LOC)   | `src/intelligence/*`            | Solid heuristics                               |
| `src/providers/factory.ts`        | `src/providers/factory.ts`      | Good architecture                              |
| `src/providers/ollama.ts`         | `src/providers/ollama.ts`       | Works                                          |
| `src/providers/openrouter.ts`     | `src/providers/openrouter.ts`   | Works                                          |
| `src/providers/fallback.ts`       | `src/providers/fallback.ts`     | Good pattern                                   |
| `src/mcp/server.ts` (691 LOC)     | `src/bridges/mcp-server.ts`     | JSON-RPC works                                 |
| `src/mcp/tools.ts`                | `src/bridges/mcp-tools.ts`      | Tool definitions                               |
| `src/tui/nexus-poc.ts` (1322 LOC) | `src/tui/` (refactor)           | Foundation for Nexus                           |
| `SOUL.md`                         | `SOUL.md`                       | Core identity                                  |
| All smoke scripts                 | `scripts/`                      | Ops infrastructure                             |
| All tests (377 cases)             | `tests/`                        | Test infrastructure                            |

### ❌ DROP

| What                        | Why                               |
| --------------------------- | --------------------------------- |
| `src/tui-old/*` (blessed)   | Replaced by pi-tui Nexus          |
| `src/memory/chain.ts`       | Replaced by Rust core             |
| `src/utils/hash.ts`         | Replaced by Rust core             |
| `src/utils/crypto.ts`       | Replaced by Rust vault            |
| `src/utils/encryption.ts`   | Replaced by Rust vault            |
| `src/collective/*`          | Nice but not MVP — add in Phase 6 |
| `src/meta-cognitive/*`      | Nice but not MVP — add in Phase 6 |
| `src/bot/telegram.ts`       | Not MVP — add in Phase 7          |
| `src/bridges/openclaw*`     | Merge into bridges/tool-router    |
| `memphis/memphis/` (nested) | Old version, confusion source     |
| `src/chains/log.ts`         | Move to Rust                      |

### 🔄 REWRITE

| What                     | From                                    | To                                         |
| ------------------------ | --------------------------------------- | ------------------------------------------ |
| `src/memory/store.ts`    | TS file I/O                             | Thin wrapper calling Rust via napi         |
| `src/config/loader.ts`   | Works but needs provider config section | Add provider priority, vault ref           |
| `src/core/onboarding.ts` | CLI-only                                | TUI-first with CLI fallback                |
| `src/embeddings/*`       | TS-only                                 | Call Ollama from TS, store vectors in Rust |

---

## 9. PHASED ROADMAP

### Phase 0: Foundation (Week 1-2) — "Can it build?"

**Goal:** Rust core compiles, napi bridge works, TS shell builds.

Tasks:

- [ ] Create Cargo workspace with 4 crates
- [ ] Implement `Block`, `MemoryChain`, `SoulValidator` in Rust
- [ ] Write Rust unit tests (block creation, chain append, validation)
- [ ] Set up napi-rs bridge with 3 functions: `chain_append`, `chain_validate`, `chain_query`
- [ ] TS wrapper that calls Rust instead of old JS chain code
- [ ] `npm run build:rust && npm run build` works
- [ ] Migrate existing chain JSON files (import_json)
- [ ] **Gate:** `cargo test` PASS + `vitest` PASS on chain operations

### Phase 1: Vault (Week 2-3) — "Is it secure?"

**Goal:** Vault with Argon2id + AES-256-GCM + 2FA Q&A in Rust.

Tasks:

- [ ] Implement vault crate (encrypt, decrypt, key derivation)
- [ ] Implement 2FA (passphrase + Q&A)
- [ ] DID generation (ed25519 keypair)
- [ ] napi bridge for vault operations
- [ ] `memphis vault init` creates vault with full setup
- [ ] `memphis vault add/get/list` work through Rust
- [ ] Provider API keys stored in vault
- [ ] **Gate:** Vault smoke test PASS, can store/retrieve API key

### Phase 2: Providers + Ask (Week 3-4) — "Can it think?"

**Goal:** `memphis ask` works with any provider, configured in YAML.

Tasks:

- [ ] Port provider factory from current code
- [ ] Add Anthropic + DeepSeek providers
- [ ] Add `memphis provider add/list/test` commands
- [ ] Provider API keys read from vault
- [ ] `memphis ask "question"` works end-to-end
- [ ] Recall uses Rust chain query
- [ ] **Gate:** `memphis ask "What can you do?"` returns answer via Ollama

### Phase 3: TUI Nexus (Week 4-6) — "Can I see it?"

**Goal:** `memphis tui` launches working dashboard.

Tasks:

- [ ] pi-tui app shell with tab navigation
- [ ] Dashboard screen (status, recent blocks, health)
- [ ] Chat screen (`ask` in interactive mode)
- [ ] Journal screen (browse + add)
- [ ] Provider screen (add/remove/test/reorder)
- [ ] Status bar (provider, chain health, vault status)
- [ ] Theme system (dark/light)
- [ ] **Gate:** TUI launches, all 4 screens navigate, chat returns LLM response

### Phase 4: Onboarding (Week 6-7) — "Can someone else use it?"

**Goal:** Fresh install → working Memphis in 5 minutes.

Tasks:

- [ ] `memphis init` triggers interactive setup (TUI-first, CLI fallback)
- [ ] Passphrase + 2FA setup
- [ ] Provider picker with health test
- [ ] Genesis blocks created
- [ ] Post-setup smoke test (`memphis doctor`)
- [ ] Install script (`scripts/install.sh`)
- [ ] README.md rewrite (Quick Start → 5 min)
- [ ] **Gate:** Someone who is NOT you can install and use Memphis from scratch

### Phase 5: Decision + Intelligence (Week 7-9) — "Can it learn?"

**Goal:** Decision engine and intelligence module ported and working.

Tasks:

- [ ] Port decision engine (schema, lifecycle, inference, prediction)
- [ ] Port intelligence module (events, categorizer, suggestions)
- [ ] Decision screen in TUI
- [ ] `memphis decide` / `memphis infer` commands
- [ ] **Gate:** Memphis detects a decision from journal text and suggests it

### Phase 6: Advanced Features (Week 9-12) — "Can it grow?"

**Goal:** Collective, meta-cognitive, embeddings, MCP.

Tasks:

- [ ] Port collective module (voting, consensus)
- [ ] Port meta-cognitive (reflection, learning loop)
- [ ] Embeddings in Rust store (vectors from Ollama)
- [ ] Semantic recall in TUI
- [ ] MCP server for external tool integration
- [ ] `memphis` as MCP server for Claude Code, Cline, etc.
- [ ] **Gate:** Memphis serves as MCP tool, another AI agent uses it

### Phase 7: Polish + Distribute (Week 12-16) — "Can it ship?"

**Goal:** Published, documented, usable by strangers.

Tasks:

- [ ] npm publish
- [ ] GitHub releases with pre-built binaries
- [ ] CI/CD (build + test + release on push)
- [ ] Telegram bot (optional)
- [ ] oswobodzeni.pl integration points
- [ ] Community docs
- [ ] **Gate:** 10 people outside the project can install and use Memphis

### Phase 8: Sovereignty Features (Week 16+) — "Can it be free?"

**Goal:** Crypto-ready, decentralized, community nodes.

Tasks:

- [ ] Wallet generation in vault (optional)
- [ ] Chain signing (blocks signed with DID key)
- [ ] P2P sync (libp2p or simple SSH)
- [ ] Trade protocol v2 (DID manifests, signatures, TTL)
- [ ] Community node mode (share chains, federated recall)
- [ ] SSI credential issuance/verification
- [ ] **Gate:** Two Memphis instances can sync and verify each other's chains

---

## 10. CODER INSTRUCTIONS

### Starting from scratch (Day 1)

```bash
# 1. Create project
mkdir memphis-v4 && cd memphis-v4
cargo init --name memphis-workspace
mkdir -p crates/{memphis-core,memphis-vault,memphis-embed,memphis-napi}/src

# 2. Set up Cargo workspace
cat > Cargo.toml << 'EOF'
[workspace]
members = ["crates/*"]
resolver = "2"
EOF

# 3. Set up each crate
cd crates/memphis-core
cargo init --lib
# Add to Cargo.toml: serde, serde_json, sha2, chrono, thiserror

# 4. Write Block + Chain + SOUL (see specs above)
# Start with: block.rs → hash.rs → soul.rs → chain.rs → lib.rs

# 5. Write tests
cargo test

# 6. Set up napi bridge
cd ../memphis-napi
# Follow: https://napi.rs/docs/introduction/getting-started

# 7. Set up TS shell
cd ../../
npm init -y
npm install commander chalk yaml zod @mariozechner/pi-tui
npm install -D typescript tsx vitest @types/node napi-rs
```

### Build command

```bash
# Rust core
cd crates/memphis-napi && napi build --release

# TypeScript
npx tsc

# Combined
npm run build  # should do both
```

### Test command

```bash
# Rust
cargo test --workspace

# TypeScript
npx vitest run

# Smoke
./scripts/smoke-test.sh

# All
npm test  # runs all three
```

### Key rules for contributors

1. **All chain/vault/hash operations → Rust.** No exceptions.
2. **All UI/LLM/network → TypeScript.** No Rust HTTP clients.
3. **napi bridge is the boundary.** Keep it thin — data in, data out.
4. **Every command must work in CLI AND TUI.** Core logic in `src/core/`, UI in `src/cli/` and `src/tui/`.
5. **Provider interface is sacred.** New providers implement `Provider` interface, nothing else.
6. **Tests before merge.** Rust: `cargo test`. TS: `vitest`. Smoke: `scripts/smoke-test.sh`.
7. **SOUL.md is immutable.** Block rules don't change. Ever. New features = new block types, not new rules.

---

## 11. DOES THIS MEAN COMPLETE REFACTOR?

**Not exactly.** It's more like:

- **New foundation** (Rust core) — built from scratch
- **Salvaged middle** (ask, decision, intelligence, providers) — moved as-is
- **New UI** (pi-tui Nexus) — built on existing POC
- **New onboarding** — built from scratch
- **Dropped dead weight** (blessed TUI, nested repo, duplicated code)

About 40% of your current 36K LOC survives as-is. 30% gets rewritten. 30% gets dropped. The Rust core is ~3-5K LOC new code. Total result: cleaner, smaller, faster, more secure.

---

_Memphis v4: Record → Detect → Predict → Reflect → Sync_
_Built by Elathoxu Abbylan. Memory that cannot be forged is memory that cannot be forgotten._
