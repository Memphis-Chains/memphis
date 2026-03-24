# MemphisOS: Rust Crates, NAPI Bridge & SQLite — Architecture & Operations

## 1. Rust Crates Dependency Graph

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
│ (foundation)  │      │  (standalone)   │      │                  │
│               │      │                 │      │ depends on       │
│ • Block       │      │ • AES-256-GCM   │      │ memphis-core     │
│ • SHA-256     │      │ • Argon2id KDF  │      │   ↕              │
│ • Ed25519 sig │      │ • Ed25519 DID   │      │ MemoryChain      │
│ • Soul valid. │      │ • 2FA (HKDF)    │      │ Block            │
│ • Loop engine │      │ • No internal   │      │                  │
│ • Harness     │      │   crate deps    │      │                  │
└───────┬───────┘      └─────────────────┘      └────────┬─────────┘
        │                                                  │
        │            ┌──────────────────┐                 │
        │            │memphis-case-index│                 │
        │            │                  │                 │
        │            │ depends on       │                 │
        └───────────►│ memphis-core    │◄────────────────┘
                     │                  │
                     │ Block, BlockType │
                     │ CaseEntry        │
                     │ CaseQuery        │
                     └──────────────────┘
```

### Dependency Summary

| Crate | Depends On | Nature | Key Exports |
|-------|-----------|--------|------------|
| `memphis-core` | _(none)_ | Self-contained | Block, SHA-256, Ed25519, Soul validation, Loop engine, Harness replay |
| `memphis-vault` | _(none)_ | Fully standalone | AES-256-GCM, Argon2id, DID generation, 2FA/HKDF |
| `memphis-embed` | `memphis-core` | `MemoryChain`, `Block` types | EmbedPipeline, VectorStore, ChainRef, LRU cache |
| `memphis-case-index` | `memphis-core` | `Block`, `BlockType`, `CaseEntry`, `CaseQuery` | SQLite-backed case index (8 grammatical cases) |
| `memphis-napi` | **all of them** | Aggregator/dispatcher | NAPI exports: chain\_\*, vault\_\*, embed\_\*, case\_\*, soul\_\* |

> **Note:** `memphis-vault`'s dev-dependencies do pull in `memphis-core` and `memphis-embed` for testing, but these are **dev-only** and not present in production builds.

---

## 2. How TypeScript Connects to Rust

### 2.1 The NAPI Bridge

`memphis-napi` compiles to a **native Node.js addon** (`*.so` on Linux). TypeScript loads it dynamically at runtime via `createRequire`:

```typescript
// napi-contract.ts
import { createRequire } from 'node:module';

export function loadBridgeModule(path: string) {
  const req = createRequire(`${process.cwd()}/`);
  return req(path);  // dynamic import of the .so file
}
```

Default path: `./crates/memphis-napi` (overridable via `RUST_CHAIN_BRIDGE_PATH`).

### 2.2 Alias Resolution (compatibility layer)

Rust exports `snake_case` names; TS also accepts `camelCase` aliases. The bridge resolver tries both:

```typescript
const CHAIN_BRIDGE_ALIASES = {
  chain_append: ['chain_append', 'chainAppend'],
  embed_store: ['embed_store', 'embedStore'],
  // ...
};
```

### 2.3 Four Adapter Layers

```
TypeScript
    │
    ├── chain-adapter.ts              ← routes: "rust-napi" or "ts-legacy"
    │         │
    │         ├── rust-chain-adapter.ts   (NapiChainAdapter)
    │         │    ├── chain_append / chain_validate / chain_query
    │         │    ├── embed_store / embed_search
    │         │    └── soul_loop_step / soul_replay
    │         │
    │         └── (TS fallback)       ← pure-TS SHA-256 chain writes
    │
    ├── rust-vault-adapter.ts        (vaultInit / vaultEncrypt / vaultDecrypt)
    │         └── new: vault_init_full / vault_store / vault_retrieve
    │         └── legacy: vault_init_json / vault_encrypt / vault_decrypt
    │
    ├── rust-embed-adapter.ts        (embedStore / embedSearch / embedSearchTuned)
    │         └── embed_store / embed_search / embed_search_tuned / embed_reset
    │
    └── case-chain-adapter.ts        (caseAppend / caseQuery / caseRebuild)
             └── case_append / case_query / case_rebuild
```

### 2.4 Feature Flag

```typescript
// Enabled via RUST_CHAIN_ENABLED=true
// Falls back to pure-TS if Rust bridge unavailable
export function getChainAdapterStatus(rawEnv): ChainAdapterStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED, false);
  return rustEnabled ? { backend: 'rust-napi' } : { backend: 'ts-legacy' };
}
```

### 2.5 Communication Pattern

All calls are **synchronous JSON round-trips** through NAPI:

```
TS                           Rust (memphis-napi)
 │                                   │
 │  chain_append(chainJson, blockJson)  │
 │ ─────────────────────────────────► │  serde_json::from_str → Block
 │                                   │  validate_block() + maybe_sign()
 │                                   │  blocks.push(block)
 │ ◄───────────────────────────────── │  serde_json::to_string(ApiResult)
 │  { ok: true, data: { appended, chain } }
```

---

## 3. Two Independent SQLite Databases

### 3.1 TypeScript SQLite: `better-sqlite3`

**Crate:** `better-sqlite3` (native Node.js binding)

**Path:** `data/memphis.db` (or `MEMPHIS_DATA_DIR/memphis.db`)

**Schema (v8):**

```sql
-- Sessions & generation tracking
sessions (id, created_at, updated_at)
generation_events (id, session_id, provider_used, model_used, timing_ms, request_id, created_at)

-- Single and dual approvals
approvals (approval_request_id, initiator_id, approver_id, state_version, created_at)
dual_approval_requests (request_id, action, state, initiator_id, approver_id, signature, expires_at_ms, ...)
dual_approval_events (event_id, request_id, from_state, to_state, actor_id, signature, created_at)
dual_approval_idempotency (approval_request_id, request_id, action, actor_id, created_at)

-- Tool permissions & approvals
tool_permissions (tool_name, policy, updated_at)
tool_call_approvals (request_id, tool_name, arguments_json, caller_id, state, expires_at_ms, ...)

-- Agent self-modification
evolve_sessions (id, authorized_at, expires_at_ms, intent, status, committed_hash, ...)

-- Proposal replay protection
seen_proposals (proposal_id, received_at)

-- Scheduled jobs
scheduled_jobs (id, type, payload, status, scheduled_at_ms, interval_ms, retry_count, ...)

-- Federation & webhooks
webhook_events (event_id, source, event_type, payload, status, retry_count, ...)
agent_peers (did, name, endpoint, capabilities, status, last_seen_at, ...)
```

**Settings:** WAL journal mode, foreign keys enabled.

---

### 3.2 Rust SQLite: `rusqlite` (bundled)

**Crate:** `rusqlite` with `features = ["bundled"]` (ships its own SQLite, independent of TS's SQLite)

**Path:** `data/case-index.sqlite` (path constructed by TS and **passed as string argument** to Rust)

**Purpose:** Indexes `Case` blocks from the `cases` chain using Polish grammatical cases.

**Schema:**

```sql
case_entries (
    block_index INTEGER PRIMARY KEY,
    block_hash TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'cases',
    case_type TEXT NOT NULL,   -- nominative, genitive, dative, accusative,
                               -- instrumental, locative, ablative, vocative
    -- 8 grammatical case fields (denormalized):
    entity, actor, target, instrument, location,
    origin, destination, owner, possessed,
    giver, recipient, object, subject, verb,
    invoker, invocation, entry_timestamp,
    full_json TEXT NOT NULL,
    indexed_at TEXT NOT NULL
)
-- 9 indexes on query fields
```

**Key:** The Rust SQLite is **passive** — TS manages the path and passes it to Rust. Chain block files (`NNNNNN.json`) are the **source of truth**; the SQLite index is a **searchable cache** that can be rebuilt at any time via `case_rebuild`.

---

### 3.3 Data Flow for Case Operations

```
TS: CaseChainAdapter.appendCaseEntry(entry)
    │
    ├── reads existing chain blocks from filesystem
    ├── constructs case entry JSON
    │
    ▼
NAPI: case_append(chainJson, entryJson, "data/case-index.sqlite")
    │
    ├── memphis-core: validates block, computes SHA-256 hash
    │
    └── memphis-case-index:
            CaseIndex::open(path)           ← opens SQLite at given path
            CaseIndex::index_block(&block)  ← INSERT into case_entries
    │
    ▼
Returns: { appended: true, indexed: true, length, chain }
```

---

## 4. Embeddings Persistence

**File:** `crates/memphis-napi/data/embed-index.json`

**Purpose:** On-disk state of the `memphis-embed` VectorStore.

```json
{
  "version": 1,
  "dim": 32,
  "docs": [
    {
      "id": "doc-a",
      "text": "local deterministic embeddings",
      "vector": [0.037..., ...],  // 32-dim L2-normalized f32
      "tags": []
    }
  ]
}
```

**Behavior:** Written atomically (write to `.tmp` → rename) when `RUST_EMBED_PERSIST_ENABLED=true`. Default path is `~/.memphis/embed/index-v1.json`. The file under `crates/memphis-napi/data/` appears to be a **test artifact** rather than production runtime data.

---

## 5. Operations Suggestions

### 5.1 Build & Deployment

- **Always run `npm run build:rust`** after pulling changes that touch any crate. Without a rebuild, `RUST_CHAIN_ENABLED=true` will fail at runtime.
- The Rust cdylib (`.so`) is output to `crates/memphis-napi/target/release/` (or `debug/`). The TS bridge defaults to `./crates/memphis-napi` which resolves via Node's require mechanism.
- If deploying to a non-standard environment, set `RUST_CHAIN_BRIDGE_PATH` to the actual location of the compiled `.so` file.

### 5.2 Feature Flags

| Flag | Default | Effect |
|------|---------|--------|
| `RUST_CHAIN_ENABLED` | `false` | Enable Rust NAPI backend; falls back to pure-TS if `false` or bridge unavailable |
| `RUST_CHAIN_BRIDGE_PATH` | `./crates/memphis-napi` | Path to the compiled `.so` file |
| `RUST_CHAIN_REQUIRE_SIGNATURES` | `false` | Reject unsigned blocks when `true` |
| `RUST_CHAIN_SIGNER_KEY_HEX` | _(none)_ | Ed25519 hex key for auto-signing blocks |
| `RUST_CHAIN_SIGNER_ALLOWLIST` | _(none)_ | Comma-separated list of allowed signer public keys |
| `RUST_EMBED_MODE` | `local` | `local` (deterministic), `ollama`, `openai-compatible`, `cohere`, `jina`, etc. |
| `RUST_EMBED_DIM` | `32` | Embedding vector dimension |
| `RUST_EMBED_PERSIST_ENABLED` | `false` | Enable embed index persistence to disk |
| `RUST_EMBED_PERSIST_PATH` | `~/.memphis/embed/index-v1.json` | Embed persistence file path |
| `MEMPHIS_VAULT_PEPPER` | _(none)_ | Pepper for vault state v2 encryption (min 12 chars) |
| `MEMPHIS_VAULT_STATE_PATH` | `./data/vault-state.json` | Vault state file path |

### 5.3 Vault Operations

- **Initialization:** `vault init` requires a passphrase, recovery question, and recovery answer. Store the recovery answer securely — it is the only way to recover encrypted secrets.
- **Pepper requirement:** `MEMPHIS_VAULT_PEPPER` (min 12 chars) is required to decrypt vault state v2. Without it, the vault falls back to plaintext base64 (v1) which is less secure.
- **Key rotation:** The vault supports transparent upgrade from v1 to v2 on load if pepper is available. No manual migration needed.
- **DID generation:** `did:memphis:z<base58btc>` format — derived from Ed25519 keypair generated on vault init.

### 5.4 Case Index Operations

- **Rebuild at any time:** `case_rebuild` scans all chain blocks and re-indexes Case entries into SQLite. Safe to run — source of truth is the chain files.
- **Startup reconciliation:** `CaseChainAdapter.reconcileIfNeeded()` automatically rebuilds the index at startup if case blocks exist but the SQLite index is out of sync.
- **No SQLite backup needed:** The `case-index.sqlite` is a derived index, not a source of truth. It can be deleted and rebuilt from chain files at any time.
- **Chain files are source of truth:** Case entries are stored as `NNNNNN.json` block files in the `cases` chain directory. The SQLite index just provides fast grammatical case queries.

### 5.5 Embeddings Operations

- **Deterministic mode:** When `RUST_EMBED_MODE=local`, embeddings are reproducible across runs (byte-based XOR with index). No external API needed.
- **Provider mode:** Set `RUST_EMBED_MODE=ollama` (or any supported provider) plus `RUST_EMBED_PROVIDER_URL` and optionally `RUST_EMBED_PROVIDER_API_KEY`.
- **Persistence:** Enable with `RUST_EMBED_PERSIST_ENABLED=true`. The embed index survives restarts. If the file is corrupted, delete it and the pipeline rebuilds from scratch (data is lost unless re-upserted).
- **Cache:** TS-side LRU cache (128 entries, 15s TTL default) sits in front of Rust embed search. Bypass by calling the NAPI functions directly or by setting `EMBED_CACHE_TTL_SECONDS=0`.

### 5.6 Chain Integrity

- **Genesis block:** Memphis accepts index 0 (Rust convention) or index 1 (TypeScript convention) as valid genesis.
- **Hashing:** SHA-256 canonical JSON of `(index, timestamp, chain, data, prev_hash)`. The `hash` field itself is excluded from the hash computation.
- **Signature policy:** When `RUST_CHAIN_REQUIRE_SIGNATURES=true`, unsigned blocks are rejected. Use `RUST_CHAIN_SIGNER_KEY_HEX` to configure auto-signing.
- **Allowlist:** `RUST_CHAIN_SIGNER_ALLOWLIST` restricts which Ed25519 public keys can sign blocks.

### 5.7 SQLite Backup Priority

| Database | Path | Priority | Can Be Rebuilt? |
|----------|------|----------|----------------|
| `memphis.db` (TS) | `data/memphis.db` | **High** — source of truth for approvals, sessions, evolve, scheduled jobs | No — stateful application data |
| `case-index.sqlite` (Rust) | `data/case-index.sqlite` | Low — derived index | **Yes** — rebuild via `case_rebuild` |
| `embed-index.json` (Rust) | `~/.memphis/embed/index-v1.json` | Low — in-memory cache | **Yes** — re-upsert documents |
| `vault-state.json` (TS) | `data/vault-state.json` | **Critical** — encrypted master key | No — contains encrypted secrets |
| Chain block files | `~/.memphis/chains/*/NNNNNN.json` | **Critical** — source of truth for all chains | N/A |

### 5.8 Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `RUST_CHAIN_ENABLED=true` but bridge unavailable | Rust not built | Run `npm run build:rust` |
| Vault init fails with "pepper too short" | `MEMPHIS_VAULT_PEPPER` < 12 chars | Set a longer pepper |
| Case queries return no results | SQLite index out of sync | Run `case_rebuild` or restart (auto-reconciles) |
| Embeddings not persisted across restarts | `RUST_EMBED_PERSIST_ENABLED=false` | Set to `true` |
| Block append fails with "hash mismatch" | Strict validation enabled, legacy hash format | Set `MEMPHIS_STRICT_CHAIN_VALIDATION=false` or re-index chain |
| NAPI call returns `bridge not loaded` | Wrong `RUST_CHAIN_BRIDGE_PATH` or architecture mismatch | Verify `.so` exists at path and matches Node.js architecture |
