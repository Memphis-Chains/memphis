# WatraLLM Evaluation Specification

**Date:** 2026-04-22
**Status:** Approved

## Eval Set

100 held-out query/pointer pairs, stratified by category:

| Category | Count | Source |
|----------|-------|--------|
| Memphis structure | 20 | tool-registry, chain catalog, cognitive modes |
| Safety / drills | 20 | security/*, auth/*, runbooks |
| Code-modification patterns | 20 | git log, PR patterns, invariants |
| Tools API | 20 | tool handlers, MCP server |
| Skills creation | 20 | skills manifest, CLI workflow |

### Holdout enforcement

Eval pairs are generated separately from training pairs and verified to have zero overlap (exact query match + fuzzy dedup with edit distance threshold 0.3).

## Metrics

### Primary: Pointer Accuracy

```
accuracy = correct_pointers / total_queries
```

A pointer is correct when:
1. `chain` matches the ground truth chain exactly.
2. `selector` matches the ground truth selector (exact or fuzzy match with cosine similarity ≥ 0.8 on selector text).

**Target:** ≥ 70% pointer accuracy.

### Secondary: Confidence Calibration

```
calibration_error = mean(|predicted_confidence - empirical_accuracy|) per bin
```

Bin predictions by confidence decile (0.0–0.1, 0.1–0.2, ..., 0.9–1.0). For each bin, compare mean predicted confidence to actual accuracy in that bin. Well-calibrated model: predicted confidence ≈ actual accuracy.

**Target:** Mean calibration error < 0.15.

### Per-Chain Recall

```
recall(chain_i) = correct_predictions_for_chain_i / total_queries_targeting_chain_i
```

Reports recall per chain to identify systematic blind spots. If one chain consistently gets < 50% recall, the corpus needs more examples for that chain.

**Target:** No chain below 50% recall.

### Latency

```
p50_latency, p95_latency, p99_latency (ms per query)
```

Measured on GTX 960 with 4-bit quantized model.

**Target:** p95 < 200ms per query.

## Baselines

### Baseline 1: Zero-shot base model + system prompt

Run the untrained Qwen3-0.6B-base with the Memphis system prompt (from `src/soul/manifest.ts`, ~24KB). Measure pointer accuracy. This establishes the floor — how well does the model route with only prompt engineering?

Expected: 15–30% accuracy (base model has no Memphis domain knowledge).

### Baseline 2: Few-shot base model

Same as baseline 1, but include 5 example query/pointer pairs in the prompt. Measures in-context learning capability.

Expected: 25–40% accuracy.

### Target: Post-training LoRA-merged

Fine-tuned Qwen3-0.6B with LoRA merged back to base weights.

Target: ≥ 70% accuracy. If < 65%, escalate to Qwen3-1.7B (escape floor decision).

## Eval Script

```
tools/training/eval-watra.py
```

### Usage

```bash
# Run eval against local Ollama model
python tools/training/eval-watra.py \
  --model ollama:watra-v1 \
  --eval-set tools/training/corpus/eval.jsonl \
  --output tools/training/results/eval-v1.json

# Run baseline (zero-shot)
python tools/training/eval-watra.py \
  --model ollama:qwen3:0.6b \
  --eval-set tools/training/corpus/eval.jsonl \
  --baseline zero-shot \
  --system-prompt src/soul/manifest.ts \
  --output tools/training/results/baseline-zero-shot.json
```

### Output format

```json
{
  "model": "watra-v1",
  "eval_set": "eval.jsonl",
  "timestamp": "2026-05-15T10:00:00Z",
  "metrics": {
    "pointer_accuracy": 0.73,
    "calibration_error": 0.11,
    "per_chain_recall": {
      "journal": 0.80,
      "decisions": 0.75,
      "cases": 0.65,
      "system-events": 0.70,
      "soul": 0.72
    },
    "latency": {
      "p50_ms": 45,
      "p95_ms": 120,
      "p99_ms": 180
    }
  },
  "errors": [
    {
      "query": "...",
      "expected": { "chain": "decisions", "selector": "..." },
      "predicted": { "chain": "journal", "selector": "..." },
      "confidence": 0.6
    }
  ]
}
```

## Decision Gates

| Metric | Pass | Escalate | Fail |
|--------|------|----------|------|
| Pointer accuracy | ≥ 70% | 65–70% (try more data) | < 65% (switch to 1.7B) |
| Calibration error | < 0.15 | 0.15–0.25 (temperature tune) | > 0.25 (architecture issue) |
| Per-chain recall | all ≥ 50% | 1 chain < 50% (add data) | 3+ chains < 50% (corpus issue) |
| p95 latency | < 200ms | 200–500ms (quantize more) | > 500ms (model too large) |

## Schedule

- **Sprint 2:** Generate eval set alongside training corpus
- **Sprint 3:** Run baselines + first training eval
- **Sprint 4:** Iterate on corpus based on per-chain recall gaps
- **Sprint 5:** Final eval before WatraLLM v1 deployment
