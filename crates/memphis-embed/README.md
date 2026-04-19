# memphis-embed

Embedding pipeline + cache + chain integration. Central to Memphis's RAG and semantic-recall paths.

## Public surface

- `pipeline.rs` — embedding generation (Ollama / OpenAI / hash-fallback)
- `store.rs` — vector store (cosine similarity, top-k retrieval)
- `cache.rs` — embed-result cache (content-addressed)
- `chain_integration.rs` — extract embeddable text from chain blocks; rebuild flow

## Build

```bash
cargo build -p memphis-embed
cargo test -p memphis-embed --lib
```

## Layer

L1+L2 boundary. Owns the embedding store (storage L1) and the cascade decision logic (runtime L2). Exposed to TS via `memphis-napi` (`embed_store`, `embed_search`).

## Sovereign-RAG cascade (M6 plan)

Currently: hash-based fallback ⊕ Ollama (`nomic-embed-text` default) ⊕ OpenAI.

Planned (M6 in `docs/ROADMAP-CURRENT.md`): add `OnnxLocalProvider` as Tier 0 (always-available CPU embeddings via `ort` + pre-shipped `multilingual-e5-small` ONNX model). This makes Memphis fully sovereign — semantic search works on a 2011 CPU without GPU and without internet (proven on Intel i3-2120, 2026-04-19, 68 docs / 797 chunks / cross-lingual EN→PL search).
