# WatraLLM Base Model Decision

**Decision:** Qwen3-0.6B-base (non-instruct)
**Date:** 2026-04-22
**Status:** Approved

## Context

WatraLLM is a pointer/router model that emits `{ chain, selector, reasoning, confidence }` — it does NOT generate text. It routes queries to the correct chain and selector. This is a constrained decision problem, not a generation task.

Requirements:
- **Censure-free:** No RLHF alignment, no content refusal. Base weights only.
- **Apache-2.0 or equivalent:** Commercial-fork compatible (Y2 Q2 target).
- **Fits 4 GB VRAM:** GTX 960 with CUDA compute 5.2.
- **Trainable on-device:** QLoRA fine-tuning must fit in 4 GB VRAM.

## Decision: Qwen3-0.6B-base

| Property | Value |
|----------|-------|
| Parameters | 600M |
| Size | 307 MB (FP16) |
| License | Apache-2.0 |
| VRAM (inference) | ~1.2 GB (FP16), ~600 MB (4-bit) |
| VRAM (QLoRA training) | ~2.5 GB estimated |
| Source | HuggingFace (Qwen/Qwen3-0.6B) |
| Agent task accuracy | 84% (AgentGate benchmark) |

### Why 0.6B, not 1.7B?

Qwen3-1.7B scores 87% on agent tool-selection benchmarks — only 3% better than 0.6B. But inference is 2-3x slower on the GTX 960, and QLoRA training VRAM approaches 4 GB limit with no headroom. The 3% accuracy gain is not worth the operational risk.

### Why not instruct-tuned?

Instruct-tuned models (phi-4-mini, Bielik-instruct, etc.) include RLHF alignment that:
1. Adds refusal behaviors we'd need to un-train.
2. Biases outputs toward helpful-text generation rather than structured pointer emission.
3. Violates the censure-free requirement for sovereign runtime.

Base weights are a clean slate for pointer/router fine-tuning.

## Escape Floor

If Qwen3-0.6B pointer accuracy < 65% after training:

1. **Upgrade:** Qwen3-1.7B-base (same family, marginally better, tighter VRAM)
2. **Escape floor:** Qwen3-4B-base (4-bit quantized fits 4 GB VRAM, same model family for training code reuse)

The escape floor replaces the earlier TinyLlama-1.1B plan. Staying within the Qwen3 family means tokenizer/architecture code works unchanged.

## Training Stack

### Decision tree (empirical)

```
Step 1: pip install unsloth && python -c "import unsloth"
  ├─ Success (CUDA 5.2 compat) → Unsloth primary
  │   Benefits: 2x faster training, 30% less VRAM, Qwen3 supported
  │
  └─ Failure (CUDA 5.2 incompatible) → HuggingFace + PEFT fallback
      Benefits: wider hardware compat, well-documented, proven
```

### CUDA 5.2 compatibility matrix

| Component | CUDA 5.2 status |
|-----------|-----------------|
| PyTorch 2.x | Supported (with fallback kernels) |
| bitsandbytes | Needs verification — some 4-bit kernels require SM 7.0+ |
| Unsloth | Needs verification — uses custom CUDA kernels |
| HF Transformers | Supported |
| PEFT/LoRA | Supported (CPU fallback for unsupported ops) |

### Training weights source

HuggingFace base weights (safetensors format), NOT Ollama GGUF. Ollama quantizes to GGUF for inference — this format is not suitable for gradient-based training. The HF → Ollama conversion happens post-training.

## Validation

AgentGate paper (arXiv:2604.06696, 2026-04-08) validates the pointer/router architecture:
> "Compact models (< 1B parameters) provide competitive routing performance in constrained settings when fine-tuned on domain-specific candidate sets."

This matches WatraLLM's design: the model sees a fixed set of chains/selectors (not open-ended generation) and learns to route accurately within that constrained space.

## Hardware Context

| Component | Spec | Implication |
|-----------|------|-------------|
| CPU | i3-2120 (4 threads, 2011) | No AVX2 — ONNX path dead |
| RAM | 16 GB (10 GB available) | Sufficient for training |
| GPU | GTX 960 (4 GB VRAM, CUDA 5.2) | QLoRA possible; verify bitsandbytes |
| Disk | 290 GB (190 GB free) | Sufficient |

## Timeline

- **Sprint 1 (current):** Decision document + CUDA 5.2 compat check
- **Sprint 2 (Q1):** Corpus generation + training script
- **Sprint 3 (Q1):** Training run + eval
- **Sprint 5 (Q2):** WatraLLM embed from last-hidden-state (dual-role)
- **Q3:** vLLM for production inference
