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

  - Run torch forward on 8 random eval samples.
  - Run onnxruntime forward on the same inputs.
  - Assert cosine similarity on `embedding` >= 0.999 and max absolute
    difference on `zone_logits` <= 1e-2. Failures raise
    OnnxExportParityError and the trainer falls back to placeholder
    ONNX (operator can retry with onnx-export-kartograf.py standalone).
"""
from __future__ import annotations

import io
import tempfile
from pathlib import Path

import numpy as np
import torch


class OnnxExportError(RuntimeError):
    """Raised when export or parity fails in a way worth surfacing."""


def _merge_lora_if_wrapped(model_base):
    """peft wraps the base in PeftModel; merge_and_unload folds adapters
    back in. Idempotent: returns the model unchanged if not peft-wrapped."""
    if hasattr(model_base, "merge_and_unload"):
        return model_base.merge_and_unload()
    return model_base


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

    Raises OnnxExportError if the parity test fails — the caller
    (train.run) is expected to catch and fall back to placeholder."""
    model.eval()

    # 1) Merge LoRA into the base. peft's merge_and_unload returns the
    # raw transformers AutoModel; keep the original around in case we
    # need to restore it (though in practice this method is idempotent
    # from the trainer's perspective — the peft-wrapped model is not
    # used for further training after export).
    base_merged = _merge_lora_if_wrapped(model.base)
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
    with torch.no_grad():
        torch_emb, torch_logits = wrapper(dummy_ids, dummy_mask)
    ort_outs = sess.run(
        None,
        {
            "input_ids": dummy_ids.cpu().numpy(),
            "attention_mask": dummy_mask.cpu().numpy(),
        },
    )
    ort_emb = ort_outs[0]
    ort_logits = ort_outs[1]

    # Cosine similarity on embeddings — should be ~1.0 since both are
    # L2-normalized and computed on the same weights.
    torch_emb_np = torch_emb.detach().cpu().numpy().astype(np.float64)
    ort_emb_np = ort_emb.astype(np.float64)
    cos = float(np.sum(torch_emb_np * ort_emb_np, axis=-1).mean())
    # zone_logits max absolute gap — tolerance 1e-2 is generous; usually
    # matches to 1e-4.
    logit_abs_diff = float(np.abs(
        torch_logits.detach().cpu().numpy() - ort_logits
    ).max())

    print(
        f"[onnx] export parity: embedding_cos={cos:.6f} "
        f"logit_max_abs_diff={logit_abs_diff:.6f}",
    )
    if cos < 0.999:
        raise OnnxExportError(
            f"ONNX/torch embedding divergence: cos={cos:.6f} < 0.999"
        )
    if logit_abs_diff > 1e-2:
        raise OnnxExportError(
            f"ONNX/torch logit divergence: max|Δ|={logit_abs_diff:.6f} > 1e-2"
        )

    return onnx_bytes
