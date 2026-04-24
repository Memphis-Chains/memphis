"""Kartograf training package (Y1 Q2 N32).

Real ModernBERT-base + LoRA + two-head trainer. Invoked by
tools/training/train-kartograf.py — do not import as a top-level
operator runtime dependency.

Submodules:
  - data     dataset + dataloader + class-balanced sampler + pair loader
  - model    ModernBERT + LoRA + EmbedHead (256d) + ZoneHead (12)
  - loss     InfoNCE + weighted CE multi-task
  - train    training loop + eval hook + ONNX export
  - eval     retrieval P@10 + zone accuracy + ECE (Phase 3)
"""

__version__ = "0.1.0-phase2"
