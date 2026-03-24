# Embedding Architecture

**Date:** 2026-03-24
**Scope:** MemphisOS embedding pipeline

---

## Overview

MemphisOS has two independent embedding systems that serve different purposes:

| System | Provider | Dimension | Location | Default? |
|--------|----------|-----------|----------|----------|
| **LocalDeterministic** | Rust (`memphis-embed`) | 32 | In-process | **Yes (default)** |
| **Ollama HTTP** | TypeScript layer | 768 | Network (port 11434) | No (opt-in) |

The two systems are **not composed** — they are alternative backends selected at startup via `RUST_EMBED_MODE`.

---

## System 1: Rust LocalDeterministic (Default)

**Activated when:** `RUST_EMBED_MODE=local` (this is the default)

**Crate:** `memphis-embed` (Rust)
**Dimension:** 32 (fixed, configurable via `RUST_EMBED_DIM`)
**Network:** None — fully in-process

### How it works

The `LocalDeterministicProvider` in `crates/memphis-embed/src/pipeline.rs` generates embeddings using a deterministic hash of the input bytes:

```rust
// Simplified: XOR-based deterministic hash into dim-32 vector
fn embed_local(text: &str) -> Vec<f32> {
    let bytes = text.as_bytes();
    let mut vector = [0.0f32; 32];
    for (i, &byte) in bytes.iter().enumerate() {
        vector[i % 32] ^= byte as f32;
    }
    normalize(vector)
}
```

**Key properties:**
- Reproducible: same text → same vector across runs
- No external service required
- No API key needed
- Latency: sub-millisecond (in-process)

### Configuration

```bash
RUST_EMBED_MODE=local          # default
RUST_EMBED_DIM=32             # default, fixed for LocalDeterministic
RUST_EMBED_PERSIST_ENABLED=true   # optional: persist index to disk
RUST_EMBED_PERSIST_PATH=~/.memphis/embed/index-v1.json
```

### Persistence

When `RUST_EMBED_PERSIST_ENABLED=true`, the embed index is written atomically to `~/.memphis/embed/index-v1.json` (write to `.tmp` → rename). If the file is corrupted, delete it and the pipeline rebuilds from scratch.

---

## System 2: Ollama HTTP (Opt-in)

**Activated when:** `RUST_EMBED_MODE=ollama`

**Provider:** Ollama HTTP API (`nomic-embed-text` model)
**Dimension:** 768
**Network:** HTTP call to Ollama server on port 11434 (default)
**Location in code:** TypeScript layer only — Rust does not call Ollama directly

### How it works

The TypeScript embedding layer calls Ollama over HTTP, then passes the resulting vector to the Rust NAPI boundary for storage/search:

```
TS: embedStore("doc-id", "text")
    │
    ├── HTTP POST to http://localhost:11434/api/embeddings
    │   Body: { model: "nomic-embed-text", prompt: "text" }
    │
    └── NAPI: embed_store(chainJson, blockJson)  ← 768-dim vector passed in
```

**Key constraint:** Ollama embeddings must execute in the TypeScript layer, then hand data to the Rust boundary APIs. The Rust NAPI bridge does not make HTTP calls.

### Configuration

```bash
RUST_EMBED_MODE=ollama
RUST_EMBED_PROVIDER_URL=http://localhost:11434    # default
RUST_EMBED_PROVIDER_API_KEY=                   # optional, for authenticated endpoints
```

### Ollama setup

```bash
ollama pull nomic-embed-text
ollama serve
```

---

## Runtime Routing

The embedding system is selected at **startup** via `RUST_EMBED_MODE`. There is no dynamic switching at runtime.

| `RUST_EMBED_MODE` | Provider |
|-------------------|----------|
| `local` (default) | Rust LocalDeterministic |
| `ollama` | Ollama HTTP |
| `openai-compatible` | OpenAI-compatible API |
| `cohere` | Cohere API |
| `jina` | Jina AI API |

All providers except `local` are HTTP-based and execute in the TypeScript layer before passing vectors to Rust.

---

## TS Adapter Layer

`src/infra/storage/rust-embed-adapter.ts` wraps the NAPI calls with a LRU cache:

```typescript
// Default: 128 entries, 15s TTL
const cache = new SearchCache({ maxSize: 128, ttlMs: 15_000 });

async embedStore(id: string, text: string): Promise<void> {
  // Stores via NAPI embed_store
  // Invalidates cache for the stored id
}

async embedSearch(query: string, topK = 5): Promise<SearchResult[]> {
  // Checks cache first (key = query)
  // On miss: NAPI embed_search → caches result
  // Bypasses cache if EMBED_CACHE_TTL_SECONDS=0
}
```

---

## Backward Compatibility Note

`docs/MEMORY.md` previously stated Ollama was the default embedding backend. As of v0.4.0, **LocalDeterministic is the default**. Ollama is still fully supported but must be explicitly enabled via `RUST_EMBED_MODE=ollama`.

---

## References

- `crates/memphis-embed/src/pipeline.rs` — LocalDeterministicProvider, OllamaProvider
- `crates/memphis-napi/src/lib.rs` — `embed_mode_from_env()` function
- `src/infra/storage/rust-embed-adapter.ts` — TS adapter with LRU cache
- `docs/OLLAMA-SETUP.md` — Ollama installation and verification
