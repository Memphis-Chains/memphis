"""ONNX export for Kartograf — Q2 N32 Phase 4.

Takes a trained KartografModel (peft-wrapped) and emits an ONNX file
with TWO named outputs matching the runtime contract:

  - `embedding`      [B, 256]   L2-normalized dense embedding
  - `zone_logits`    [B, 12]    raw logits (softmax at inference)

Pre-export steps:

  1. `merge_and_unload()` — fold LoRA A·B back into base weights so
     the ONNX graph needs no peft-side code at inference.
  2. Cast the merged base to FP32 for export stability. ModernBERT in
     FP16/BF16 occasionally trips ONNX checker on mask ops; exporting
     FP32 then letting onnxruntime-node pick the compute dtype at
     load time is both more portable and matches the spec's "FP16
     variant + INT8 variant" ship pair (INT8 lands Phase 4b).
  3. `torch.onnx.export` with opset 17 and dynamic batch + sequence axes.

Post-export parity test (required before shipping):

  - Run torch forward on multiple lengths, Unicode and padded batch inputs.
  - Run onnxruntime forward on the same inputs.
  - Assert cosine similarity on `embedding` >= 0.999 and max absolute
    difference on `zone_logits` <= 1e-2. Failures raise
    OnnxExportError; full training retains state and produces no checkpoint.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import torch

from .artifact_policy import assert_export_metrics


class OnnxExportError(RuntimeError):
    """Raised when export or parity fails in a way worth surfacing."""


def _merge_lora_if_wrapped(model_base):
    """peft wraps the base in PeftModel; merge_and_unload folds adapters
    back in. Idempotent: returns the model unchanged if not peft-wrapped."""
    if hasattr(model_base, "merge_and_unload"):
        return model_base.merge_and_unload()
    return model_base


def _detach_train_wrappers(base) -> None:
    """Strip wrappers that the training-time path attached: gradient
    checkpointing (uses torch._dynamo on use_reentrant=False) and any
    leftover compile state. torch.onnx.export's legacy tracer falls
    over with `Detected that you are using FX to torch.jit.trace a
    dynamo-optimized function` if these are still active.
    """
    if hasattr(base, "gradient_checkpointing_disable"):
        try:
            base.gradient_checkpointing_disable()
        except Exception:
            pass
    # Reset global dynamo state so any cached graphs from training are
    # discarded before tracing the export wrapper.
    try:
        import torch._dynamo as _dynamo
        _dynamo.reset()
    except ImportError:  # pragma: no cover
        pass


class _ExportableKartograf(torch.nn.Module):
    """ONNX-export-friendly wrapper. Contains a MERGED (non-peft) base
    plus the two heads. Runs entirely in FP32 during the export trace.
    Returns a tuple so torch.onnx.export picks up the output names via
    the `output_names` arg in the export call."""

    def __init__(self, base_merged, embed_head, zone_head):
        super().__init__()
        self.base = base_merged
        self.embed_head = embed_head
        self.zone_head = zone_head

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ):
        outputs = self.base(
            input_ids=input_ids,
            attention_mask=attention_mask,
            return_dict=True,
        )
        cls_hidden = outputs.last_hidden_state[:, 0, :].float()
        embedding = self.embed_head(cls_hidden)
        # L2-normalize in-graph so consumers can dot-product without
        # re-normalizing. Match `KartografModel.heads_forward` exactly.
        norm = embedding.norm(p=2, dim=-1, keepdim=True).clamp(min=1e-12)
        embedding = embedding / norm
        zone_logits = self.zone_head(cls_hidden)
        return embedding, zone_logits


def export_model_to_onnx(
    model,
    tokenizer,
    device: torch.device,
    max_length: int = 512,
    opset: int = 17,
) -> bytes:
    """Merge LoRA + export the whole thing to ONNX. Returns raw bytes
    suitable for hashing + inclusion in the envelope.

    Raises OnnxExportError if parity fails. Full training must abort export."""
    model.eval()

    # 0) Strip training-time wrappers (gradient_checkpointing, dynamo
    # cache) before merge_and_unload, so the merged base is a plain
    # transformers AutoModel that the legacy ONNX tracer can swallow.
    _detach_train_wrappers(model.base)

    # 1) Merge LoRA into the base. peft's merge_and_unload returns the
    # raw transformers AutoModel; keep the original around in case we
    # need to restore it (though in practice this method is idempotent
    # from the trainer's perspective — the peft-wrapped model is not
    # used for further training after export).
    base_merged = _merge_lora_if_wrapped(model.base)
    # The merged base may itself still carry the gradient_checkpointing
    # flag — disable on it too before we cast/trace.
    _detach_train_wrappers(base_merged)
    # Cast to FP32 for export stability.
    base_merged = base_merged.to(dtype=torch.float32, device=device)

    wrapper = _ExportableKartograf(
        base_merged=base_merged,
        embed_head=model.embed_head.to(dtype=torch.float32, device=device),
        zone_head=model.zone_head.to(dtype=torch.float32, device=device),
    ).to(device)
    wrapper.eval()

    # 2) Build a dummy input. seq_len for the trace can be small; the
    # exported graph has dynamic seq axis so actual inference can use
    # any length up to the tokenizer's model_max_length.
    dummy_text = "Kartograf onnx export dummy input."
    enc = tokenizer(
        dummy_text, padding="max_length", truncation=True,
        max_length=min(64, max_length), return_tensors="pt",
    )
    dummy_ids = enc["input_ids"].to(device)
    dummy_mask = enc["attention_mask"].to(device)

    # 3) Export into a bytes buffer. torch.onnx.export requires a file
    # path, so route through tempfile + read-back. The extra round-trip
    # is cheap (~20 MB file) and avoids having to manage a persistent
    # export directory.
    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        with torch.no_grad():
            torch.onnx.export(
                wrapper,
                (dummy_ids, dummy_mask),
                str(tmp_path),
                input_names=["input_ids", "attention_mask"],
                output_names=["embedding", "zone_logits"],
                dynamic_axes={
                    "input_ids":      {0: "batch", 1: "seq"},
                    "attention_mask": {0: "batch", 1: "seq"},
                    "embedding":      {0: "batch"},
                    "zone_logits":    {0: "batch"},
                },
                opset_version=opset,
                # Keep the validated dynamic_axes / single-file contract on
                # newer PyTorch, where dynamo=True became the default.
                dynamo=False,
                external_data=False,
                do_constant_folding=True,
            )
        onnx_bytes = tmp_path.read_bytes()
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass

    # 4) Parity test: load via onnxruntime, run on the same dummy input,
    # compare outputs to torch's. Use CPUExecutionProvider so this works
    # even when CUDA ORT isn't installed (typical on training rigs).
    import onnxruntime as ort

    sess = ort.InferenceSession(
        onnx_bytes, providers=["CPUExecutionProvider"],
    )
    # Test dynamic axes and masking, not only the input used for tracing.
    samples = [
        [""],
        ["Kartograf."],
        ["Zażółć gęślą jaźń — 日本語 👩🏽‍💻"],
        ["memory " * max_length],
        ["short", "a longer memory with multiple tokens"],
    ]
    for texts in samples:
        encoded = tokenizer(texts, padding=True, truncation=True,
                            max_length=max_length, return_tensors="pt")
        ids = encoded["input_ids"].to(device)
        mask = encoded["attention_mask"].to(device)
        with torch.no_grad():
            expected = wrapper(ids, mask)
        actual = sess.run(["embedding", "zone_logits"], {
            "input_ids": ids.cpu().numpy(),
            "attention_mask": mask.cpu().numpy(),
        })
        expected = [value.detach().cpu().numpy().astype(np.float64) for value in expected]
        actual = [value.astype(np.float64) for value in actual]
        for reference, exported in zip(expected, actual):
            if (reference.shape != exported.shape or reference.ndim != 2
                    or not np.isfinite(reference).all() or not np.isfinite(exported).all()):
                raise OnnxExportError("ONNX/torch parity: invalid output shape or non-finite values")
        torch_emb, torch_logits = expected
        ort_emb, ort_logits = actual
        torch_norms = np.linalg.norm(torch_emb, axis=-1, keepdims=True)
        ort_norms = np.linalg.norm(ort_emb, axis=-1, keepdims=True)
        if np.any(torch_norms <= 1e-12) or np.any(ort_norms <= 1e-12):
            raise OnnxExportError("ONNX/torch parity: zero embedding")
        cosines = ((torch_emb / torch_norms) * (ort_emb / ort_norms)).sum(axis=-1)
        gap = float(np.abs(torch_logits - ort_logits).max())
        try:
            assert_export_metrics(cosines.tolist(), gap)
        except ValueError as exc:
            raise OnnxExportError(str(exc)) from None
        print(f"[onnx] parity batch={ids.shape[0]} seq={ids.shape[1]} "
              f"min_cos={cosines.min():.6f} logit_max_gap={gap:.6f}")

    return onnx_bytes
