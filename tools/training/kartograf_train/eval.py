"""Eval hooks — Phase 3 scope. Current state: structural stubs that
return sentinel values so the envelope schema stays populated even in
--mode smoke. Phase 3 fills in the real metric computation:

  - Retrieval P@10 over eval.jsonl (build HNSW index of eval embeddings,
    query with leave-one-out pairs from pairs.jsonl).
  - Zone classification accuracy + per-class F1 on eval set.
  - Calibration via ECE (Expected Calibration Error).
  - Latency p99 by timing individual forward passes.

Smoke runs report zeros here; full runs in Phase 6 invoke real eval
via a separate call site in train.run(). For smoke validity we write
NaN-free defaults so the envelope's canonical JSON (which rejects
non-finite floats) stays valid.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class EvalResults:
    retrieval_recall_at_10: float
    zone_accuracy: float
    ece: float
    latency_p99_ms: float

    def to_dict(self) -> dict:
        return {
            "retrieval_recall_at_10": self.retrieval_recall_at_10,
            "zone_accuracy": self.zone_accuracy,
            "ece": self.ece,
            "latency_p99_ms": self.latency_p99_ms,
        }


def empty_eval_results() -> EvalResults:
    """Sentinel values for smoke runs. Envelope accepts 0.0 (finite,
    within [0,1]); Phase 3 replaces with real numbers."""
    return EvalResults(
        retrieval_recall_at_10=0.0,
        zone_accuracy=0.0,
        ece=0.0,
        latency_p99_ms=0.0,
    )
