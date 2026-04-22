# WatraLLM Embedding Strategy

**Decision:** Dual-role cascade, Ollama GPU primary
**Date:** 2026-04-22
**Status:** Approved

## Current State

The Rust `EmbedPipeline` (`crates/memphis-embed/`) supports three providers:
1. `LocalDeterministic` — hash-based 32-dim vectors (always available, poor quality)
2. `OllamaProvider` — delegates to Ollama embedding endpoint
3. `GenericOpenAIProvider` — OpenAI-compatible remote API

Current config selects a single provider via `RUST_EMBED_MODE` env var. No cascade — if the selected provider fails, embedding fails.

## Problem

1. **No fallback cascade.** Single-provider mode means a temporary Ollama restart drops all embed operations.
2. **i3-2120 has no AVX2.** ONNX CPU inference path is unusable on this hardware. Any plan relying on ONNX for embedding is dead.
3. **LocalDeterministic is low quality.** 32-dim hash vectors provide basic deduplication but poor semantic search. It should be last-resort, not primary.

## Decision: 4-Tier GPU-First Cascade

```
Tier 0: Ollama(all-minilm:l6-v2)     ← PRIMARY (GPU, 45 MB, fast)
Tier 1: Ollama(nomic-embed-text)      ← fallback (GPU, larger, better quality)
Tier 2: GenericOpenAIProvider          ← remote fallback (cloud, opt-in)
Tier 3: LocalDeterministic(32 dims)   ← last resort (always available)
```

### Why Ollama primary instead of ONNX?

| Approach | Status on i3-2120 + GTX 960 |
|----------|----------------------------|
| ONNX CPU | Dead — requires AVX2 for reasonable perf |
| ONNX GPU (CUDA) | Possible but adds CUDA runtime dependency separate from Ollama |
| Ollama GPU | Already running, GPU-accelerated, zero additional setup |

Ollama is already the primary LLM runtime. Using it for embeddings too means:
- Single GPU process manages VRAM allocation
- No ONNX runtime dependency
- Model management through `ollama pull`

### Cascade implementation

The cascade lives in `crates/memphis-embed/src/pipeline.rs`. Current implementation selects a single provider. The change:

1. `EmbedConfig` gains a `cascade: Vec<EmbedMode>` field (replaces single `mode`).
2. `EmbedPipeline::embed()` tries each provider in order, falling through on error.
3. The returned embedding includes `provider_used: String` metadata for observability.
4. Dimension normalization: all providers must produce the same dimension. If cascade members produce different dims, pad/truncate to the configured `dim`.

### all-minilm vs nomic-embed-text

| Model | Dims | Size | Quality (MTEB avg) |
|-------|------|------|-------------------|
| all-minilm:l6-v2 | 384 | 45 MB | 56.3 |
| nomic-embed-text | 768 | 274 MB | 62.4 |

all-minilm is 6x smaller and fast enough for the index sizes Memphis handles (< 100K entries). nomic is the quality fallback for cases where all-minilm is unavailable.

## Sprint 5 Decision Point: WatraLLM Embed

Once WatraLLM (Qwen3-0.6B) is trained, its last-hidden-state output can serve as a semantic embedding source — the model already "understands" Memphis domains from fine-tuning. This would be:

```
Tier 0: WatraLLM last-hidden-state    ← domain-tuned embeddings
Tier 1: Ollama(all-minilm)            ← general-purpose fallback
Tier 2: GenericOpenAIProvider          ← remote
Tier 3: LocalDeterministic             ← last resort
```

**Decision criteria for Sprint 5:**
- WatraLLM embed quality ≥ all-minilm on Memphis-domain queries (measured by recall@10 on eval set)
- Inference latency < 50ms per query (GTX 960)
- VRAM overhead acceptable alongside inference model

This decision is deferred — Sprint 1 only documents the current state and cascade redesign.

## Migration Path

1. **Sprint 1:** Document architecture (this file).
2. **Sprint 2:** Implement cascade in `EmbedPipeline`. Add `EmbedMode::Cascade` variant.
3. **Sprint 3:** Deploy cascade config. Pull `all-minilm` and `nomic-embed-text` into Ollama.
4. **Sprint 5:** Evaluate WatraLLM embed as tier-0 replacement.

## ONNX Status

ONNX is formally excluded from the embedding cascade on this hardware. If Memphis moves to a machine with AVX2+, ONNX can be re-evaluated as a tier-1 option (faster than Ollama for small models, no GPU contention). The `EmbedMode::Onnx` variant should remain in the code as a dormant path, not removed.
