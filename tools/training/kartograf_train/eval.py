"""Eval rig for Kartograf — Phase 3 (Q2 N32).

Four metrics, all computed on the held-out eval split at end of each
epoch:

  1. retrieval_recall_at_10 — for every (anchor, positive) pair in
     pairs.jsonl whose anchor is in the eval set, count 1 iff the
     positive's embedding is in the anchor's top-10 cosine neighbors
     over the full eval corpus. Report the mean.

  2. zone_accuracy — argmax(zone_logits) == zone_label, averaged.

  3. zone_macro_f1 / zone_weighted_f1 — per-class F1 scores, then
     averaged unweighted (macro) and by support (weighted).

  4. ece — Expected Calibration Error on zone predictions. Bin the
     top-1 softmax probability into 10 equal-width bins; per bin,
     |avg_confidence - accuracy| weighted by bin size.

Thresholds (from `docs/dev/KARTOGRAF-SPEC.md §Eval protocol`):
  - retrieval_recall_at_10 >= 0.75 (v1.0 target)
  - zone_accuracy >= 0.90
  - ece < 0.05

Pure numpy — no new deps beyond what the trainer already uses.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import torch
import torch.nn.functional as F


@dataclass
class EvalResults:
    retrieval_recall_at_10: float
    zone_accuracy: float
    zone_macro_f1: float
    zone_weighted_f1: float
    ece: float
    latency_p99_ms: float
    eval_size: int
    per_class_f1: dict[int, float]   # zone_idx -> F1 (populated classes only)
    retrieval_pairs_evaluated: int

    def to_dict(self) -> dict:
        return {
            "retrieval_recall_at_10": round(self.retrieval_recall_at_10, 6),
            "zone_accuracy": round(self.zone_accuracy, 6),
            "zone_macro_f1": round(self.zone_macro_f1, 6),
            "zone_weighted_f1": round(self.zone_weighted_f1, 6),
            "ece": round(self.ece, 6),
            "latency_p99_ms": round(self.latency_p99_ms, 3),
            "eval_size": int(self.eval_size),
            "retrieval_pairs_evaluated": int(self.retrieval_pairs_evaluated),
            "per_class_f1": {str(k): round(v, 6)
                             for k, v in self.per_class_f1.items()},
        }


def empty_eval_results() -> EvalResults:
    """Sentinel values for `--mode smoke` and stub paths where we don't
    want to pay for a full eval pass. All metrics are 0.0-valued
    finite floats so `canonicalize()` accepts them in the envelope."""
    return EvalResults(
        retrieval_recall_at_10=0.0,
        zone_accuracy=0.0,
        zone_macro_f1=0.0,
        zone_weighted_f1=0.0,
        ece=0.0,
        latency_p99_ms=0.0,
        eval_size=0,
        per_class_f1={},
        retrieval_pairs_evaluated=0,
    )


# ---------------------------------------------------------------------
# Per-metric implementations (pure numpy, testable in isolation)
# ---------------------------------------------------------------------

def _retrieval_recall_at_k(
    embeddings: np.ndarray,       # [N, D], already L2-normalized
    anchor_sha_by_row: list[str],  # row i -> sha256
    row_by_sha: dict[str, int],    # sha256 -> row index into embeddings
    pairs: list[tuple[str, str]],  # list of (anchor_sha, positive_sha)
    k: int = 10,
) -> tuple[float, int]:
    """Cosine Recall@K over the eval embedding bank.

    Returns (recall, pairs_counted). Only counts pairs where BOTH
    anchor and positive have embeddings in the bank.
    """
    if len(embeddings) < 2 or not pairs:
        return 0.0, 0
    # [N, N] cosine matrix since embeddings are L2-normalized.
    sim = embeddings @ embeddings.T
    # Mask self (put -inf on diagonal so argpartition never returns self).
    np.fill_diagonal(sim, -np.inf)
    # For each row, find the K largest cols. argpartition is O(N),
    # cheaper than full argsort.
    # Guard against k >= N: cap at N-1.
    k_eff = min(k, embeddings.shape[0] - 1)
    top_k_idx = np.argpartition(sim, -k_eff, axis=1)[:, -k_eff:]
    # Build a set-of-neighbors per row.
    neighbor_set_by_row = [set(top_k_idx[i].tolist())
                           for i in range(len(embeddings))]
    hits = 0
    counted = 0
    for anchor_sha, pos_sha in pairs:
        a_row = row_by_sha.get(anchor_sha)
        p_row = row_by_sha.get(pos_sha)
        if a_row is None or p_row is None:
            continue
        counted += 1
        if p_row in neighbor_set_by_row[a_row]:
            hits += 1
    if counted == 0:
        return 0.0, 0
    return hits / counted, counted


def _per_class_f1(
    y_true: np.ndarray,  # [N] int
    y_pred: np.ndarray,  # [N] int
    num_classes: int,
) -> tuple[dict[int, float], dict[int, int], float, float]:
    """Compute per-class F1 with zero-support classes excluded from
    macro average, and weighted F1 over support. Returns
    (per_class_f1, per_class_support, macro_f1, weighted_f1)."""
    per_class: dict[int, float] = {}
    per_support: dict[int, int] = {}
    for c in range(num_classes):
        tp = int(((y_pred == c) & (y_true == c)).sum())
        fp = int(((y_pred == c) & (y_true != c)).sum())
        fn = int(((y_pred != c) & (y_true == c)).sum())
        support = tp + fn
        if support == 0:
            # No eval samples from this class — skip. Zero-count zones
            # (proactive/soul/reserved_*) land here and should not drag
            # macro F1 toward 0.
            continue
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        if precision + recall == 0:
            f1 = 0.0
        else:
            f1 = 2 * precision * recall / (precision + recall)
        per_class[c] = f1
        per_support[c] = support
    if not per_class:
        return {}, {}, 0.0, 0.0
    macro = float(np.mean(list(per_class.values())))
    total_support = sum(per_support.values())
    weighted = float(sum(
        f * per_support[c] for c, f in per_class.items()
    )) / max(total_support, 1)
    return per_class, per_support, macro, weighted


def _expected_calibration_error(
    y_true: np.ndarray,          # [N] int
    confidences: np.ndarray,     # [N] float, max softmax prob per sample
    predictions: np.ndarray,     # [N] int, argmax per sample
    n_bins: int = 10,
) -> float:
    """ECE with equal-width bins over confidence in [0, 1]."""
    if len(y_true) == 0:
        return 0.0
    bin_edges = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    n = len(y_true)
    for b in range(n_bins):
        lo, hi = bin_edges[b], bin_edges[b + 1]
        # Include rightmost edge in the last bin.
        if b == n_bins - 1:
            mask = (confidences >= lo) & (confidences <= hi)
        else:
            mask = (confidences >= lo) & (confidences < hi)
        if mask.sum() == 0:
            continue
        bin_conf = float(confidences[mask].mean())
        bin_acc = float((predictions[mask] == y_true[mask]).mean())
        ece += abs(bin_conf - bin_acc) * (mask.sum() / n)
    return float(ece)


# ---------------------------------------------------------------------
# Full eval loop
# ---------------------------------------------------------------------

def _iter_batches(samples: list, batch_size: int):
    """Yield consecutive slices of `samples` of size `batch_size`."""
    for i in range(0, len(samples), batch_size):
        yield samples[i:i + batch_size]


def run_eval(
    model,
    tokenizer,
    bundle,                 # CorpusBundle from data.py
    eval_samples: list,     # list of Sample whose zone to score
    pairs_by_sha: dict,     # pairs.jsonl map for retrieval scoring
    device: torch.device,
    max_length: int = 256,
    batch_size: int = 16,
    num_classes: int = 12,
) -> EvalResults:
    """Forward every eval sample, compute metrics, return EvalResults.

    Does NOT require gradient computation; wraps model.eval() + no_grad.
    Embeddings are collected in FP32 on CPU so downstream numpy math
    is stable + memory fits even with 500+ eval samples.
    """
    if not eval_samples:
        return empty_eval_results()

    model.eval()
    all_embeddings: list[np.ndarray] = []
    all_zone_probs: list[np.ndarray] = []
    all_zone_labels: list[int] = []
    sha_order: list[str] = []
    latencies_ms: list[float] = []

    autocast_dtype = {
        "fp16": torch.float16,
        "bf16": torch.bfloat16,
        "4bit-nf4-bf16": torch.bfloat16,
    }.get(getattr(model, "loaded_precision", None) or "fp32")

    with torch.no_grad():
        for batch in _iter_batches(eval_samples, batch_size):
            texts = [s.content for s in batch]
            labels = [s.zone_idx for s in batch]
            enc = tokenizer(
                texts, padding=True, truncation=True,
                max_length=max_length, return_tensors="pt",
            )
            input_ids = enc["input_ids"].to(device, non_blocking=True)
            attn = enc["attention_mask"].to(device, non_blocking=True)

            t0 = time.perf_counter()
            if autocast_dtype is not None and device.type == "cuda":
                with torch.autocast(device_type="cuda", dtype=autocast_dtype):
                    cls_hidden = model.encode(input_ids, attn)
            else:
                cls_hidden = model.encode(input_ids, attn)
            out = model.heads_forward(cls_hidden)
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            t1 = time.perf_counter()
            # Per-sample latency, in ms.
            per_sample_ms = (t1 - t0) * 1000.0 / max(len(batch), 1)
            latencies_ms.extend([per_sample_ms] * len(batch))

            emb = out["embedding"].detach().float().cpu().numpy()
            zone_logits = out["zone_logits"].detach().float().cpu()
            zone_probs = F.softmax(zone_logits, dim=-1).numpy()

            all_embeddings.append(emb)
            all_zone_probs.append(zone_probs)
            all_zone_labels.extend(labels)
            sha_order.extend(s.sha256 for s in batch)

    embeddings = np.concatenate(all_embeddings, axis=0)
    zone_probs = np.concatenate(all_zone_probs, axis=0)
    zone_labels = np.asarray(all_zone_labels, dtype=np.int64)
    predictions = zone_probs.argmax(axis=1)
    confidences = zone_probs.max(axis=1)

    # --- Retrieval recall @ 10 ----------------------------------------
    row_by_sha = {sha: i for i, sha in enumerate(sha_order)}
    retrieval_pairs: list[tuple[str, str]] = []
    for anchor_sha in sha_order:
        pair = pairs_by_sha.get(anchor_sha)
        if pair is None:
            continue
        pos_sha = pair["positive_sha256"]
        retrieval_pairs.append((anchor_sha, pos_sha))
    recall_at_10, pairs_counted = _retrieval_recall_at_k(
        embeddings=embeddings,
        anchor_sha_by_row=sha_order,
        row_by_sha=row_by_sha,
        pairs=retrieval_pairs,
        k=10,
    )

    # --- Zone metrics -------------------------------------------------
    zone_accuracy = float((predictions == zone_labels).mean())
    per_class, _per_support, macro_f1, weighted_f1 = _per_class_f1(
        y_true=zone_labels, y_pred=predictions, num_classes=num_classes,
    )
    ece = _expected_calibration_error(
        y_true=zone_labels,
        confidences=confidences,
        predictions=predictions,
    )

    # --- Latency ------------------------------------------------------
    if latencies_ms:
        latency_p99 = float(np.percentile(latencies_ms, 99))
    else:
        latency_p99 = 0.0

    return EvalResults(
        retrieval_recall_at_10=recall_at_10,
        zone_accuracy=zone_accuracy,
        zone_macro_f1=macro_f1,
        zone_weighted_f1=weighted_f1,
        ece=ece,
        latency_p99_ms=latency_p99,
        eval_size=len(eval_samples),
        per_class_f1=per_class,
        retrieval_pairs_evaluated=pairs_counted,
    )


def format_eval_line(results: EvalResults) -> str:
    """One-liner for train-loop logging."""
    return (
        f"eval: recall@10={results.retrieval_recall_at_10:.4f} "
        f"zone_acc={results.zone_accuracy:.4f} "
        f"macro_f1={results.zone_macro_f1:.4f} "
        f"ece={results.ece:.4f} "
        f"p99_latency={results.latency_p99_ms:.1f}ms "
        f"eval_n={results.eval_size} "
        f"pairs_n={results.retrieval_pairs_evaluated}"
    )
