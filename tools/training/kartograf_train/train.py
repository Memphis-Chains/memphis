"""Training loop — AdamW + cosine LR + grad accumulation + BF16.

Public entry point: `run(config) -> TrainResult`. Called by
tools/training/train-kartograf.py after corpus validation and before
envelope signing. This module does NOT sign the envelope itself —
that stays in the invoking script to keep signing logic adjacent to
the operator's signing seed.

Smoke mode:
  - 50 optimizer steps
  - No real ONNX export (placeholder bytes, identical to N37.2 stub)
  - Eval hooks return zero sentinels
  - Goal: prove the pipeline wires end-to-end with loss decreasing.

Full mode (Phase 6 operator run):
  - 3 epochs over the full anchor set
  - Real ONNX export + eval (Phase 4/6 wiring lands in a follow-up;
    today full mode still emits placeholder ONNX so the envelope
    verifies, with a WARN log that the model bytes are not shippable).

GTX 960 4GB / i3 CPU profile per docs/dev/KARTOGRAF-SPEC.md §Training
paths. 4-bit base loading is attempted first; if bitsandbytes rejects
ModernBERT's fused QKV, we fall back to BF16 with the base frozen.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import torch
from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR
from transformers import AutoTokenizer

# Disable torch.compile / dynamo entirely. ModernBERT (transformers
# 4.48) invokes `torch.compile` on some internal paths when the GPU
# reports capability >= 7.0; on Maxwell (CC 5.2, e.g. GTX 960) the
# inductor backend fails to emit Triton kernels and the error bubbles
# up through peft's wrapped forward. Disabling dynamo at import time
# forces all compiled regions back to eager mode cleanly.
try:
    import torch._dynamo as _dynamo
    _dynamo.config.disable = True
    _dynamo.config.suppress_errors = True
except ImportError:  # pragma: no cover — dynamo bundled with torch 2.x
    pass

from .data import (
    KartografDataset,
    compute_class_weights,
    load_corpus,
    make_dataloader,
)
from .eval import EvalResults, empty_eval_results
from .loss import KartografLoss
from .model import MODEL_ID, build_model


# Placeholder ONNX — identical marker to N37.2 stub so smoke-mode
# artifacts stay shape-compatible with the existing envelope schema.
# Real ONNX export lands in Phase 4 (torch.onnx.export opset 17 +
# onnxruntime.quantization INT8 variant).
_PLACEHOLDER_ONNX = b"KARTOGRAF_STUB_ONNX_v1\nsee docs/dev/KARTOGRAF-SPEC.md"


@dataclass
class TrainConfig:
    corpus_dir: Path
    out_dir: Path
    mode: str = "smoke"  # "smoke" | "full"
    # Hyperparams (all spec-aligned defaults).
    batch_size: int = 1           # anchors per step; each drags 2+K items
    # Smoke defaults to 128 to fit GTX 960 VRAM with 6-sample forward
    # batch (1 anchor + 1 positive + 4 hard negs). Full mode overrides
    # to 512 per spec §Training paths. Memphis chain content is mostly
    # under 100 tokens anyway; doc/code samples are the long ones.
    max_length: int = 128
    lr: float = 1e-4
    weight_decay: float = 0.01
    warmup_ratio: float = 0.05
    lambda_infonce: float = 1.0
    lambda_ce: float = 0.5
    temperature: float = 0.07
    grad_accum_steps: int = 8
    grad_clip: float = 1.0
    epochs: int = 3
    # Debug knobs.
    max_steps_smoke: int = 50
    log_every: int = 5
    seed: int = 42
    prefer_4bit: bool = True
    device: str = field(default_factory=lambda:
                        "cuda" if torch.cuda.is_available() else "cpu")


@dataclass
class TrainResult:
    onnx_bytes: bytes
    onnx_sha256: str
    tokenizer_json_bytes: bytes
    tokenizer_sha256: str
    eval_results: EvalResults
    steps: int
    final_loss: float
    first_loss: float
    loaded_precision: str
    dataset_size: int
    trainable_params: int
    total_params: int


def _cosine_warmup_schedule(
    optimizer: AdamW, warmup_steps: int, total_steps: int,
) -> LambdaLR:
    def lr_lambda(step: int) -> float:
        if step < warmup_steps:
            return step / max(1, warmup_steps)
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return 0.5 * (1.0 + math.cos(math.pi * progress))
    return LambdaLR(optimizer, lr_lambda)


def _infinite(loader) -> Iterator:
    """Wrap DataLoader so `full` mode can run across epochs without
    manual epoch bookkeeping. WeightedRandomSampler already randomizes
    every epoch, so re-iteration is honest."""
    while True:
        for batch in loader:
            yield batch


def _tokenizer_json_bytes(tokenizer) -> bytes:
    """Serialize the tokenizer into the `tokenizer.json` HF format that
    onnxruntime-node's @huggingface/tokenizers expects. AutoTokenizer
    exposes `backend_tokenizer` (a `tokenizers.Tokenizer`) with a
    `.to_str()` that emits the canonical JSON."""
    if not hasattr(tokenizer, "backend_tokenizer"):
        raise RuntimeError(
            "AutoTokenizer loaded a slow tokenizer; Kartograf requires "
            "the fast (tokenizers-backed) variant. This should never "
            "happen for ModernBERT-base."
        )
    return tokenizer.backend_tokenizer.to_str().encode("utf-8")


def run(config: TrainConfig) -> TrainResult:
    torch.manual_seed(config.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config.seed)

    device = torch.device(config.device)
    print(f"[train] device={device}, mode={config.mode}")

    # 1) Tokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    tok_bytes = _tokenizer_json_bytes(tokenizer)
    tok_sha = hashlib.sha256(tok_bytes).hexdigest()

    # 2) Corpus + pairs
    bundle = load_corpus(config.corpus_dir, drop_ambiguous=True)
    if len(bundle.anchor_samples) == 0:
        raise RuntimeError(
            "no usable training samples after ambiguous/pair filter; "
            "check corpus-v1-summary.json and pairs.jsonl"
        )
    dataset = KartografDataset(bundle)
    class_weights = compute_class_weights(bundle.anchor_samples).to(device)
    loader = make_dataloader(
        dataset,
        tokenizer,
        batch_size=config.batch_size,
        max_length=config.max_length,
        use_balanced_sampler=True,
        seed=config.seed,
    )

    # 3) Model + loss. Heads stay FP32 (see KartografModel docstring);
    # base follows the precision picked by build_model().
    model = build_model(prefer_4bit=config.prefer_4bit).to(device)
    loss_fn = KartografLoss(
        class_weights=class_weights,
        lambda_infonce=config.lambda_infonce,
        lambda_ce=config.lambda_ce,
        temperature=config.temperature,
    ).to(device)
    trainable_params = [p for p in model.parameters() if p.requires_grad]
    trainable_count = sum(p.numel() for p in trainable_params)
    total_count = sum(p.numel() for p in model.parameters())
    print(
        f"[train] trainable params: {trainable_count:,} / {total_count:,} "
        f"({trainable_count / max(total_count, 1) * 100:.2f}%)",
    )

    # 4) Optimizer + scheduler
    if config.mode == "smoke":
        total_steps = config.max_steps_smoke
    else:
        # Each DataLoader iteration covers one pass over anchors; total
        # optimizer steps = epochs * (iters_per_epoch / grad_accum).
        iters_per_epoch = max(1, len(dataset) // config.batch_size)
        total_steps = (config.epochs * iters_per_epoch) // config.grad_accum_steps
    warmup_steps = max(1, int(total_steps * config.warmup_ratio))
    optimizer = AdamW(
        trainable_params,
        lr=config.lr,
        weight_decay=config.weight_decay,
        betas=(0.9, 0.999),
    )
    scheduler = _cosine_warmup_schedule(optimizer, warmup_steps, total_steps)
    # GradScaler only helps under FP16 where gradients can underflow;
    # BF16 has the same exponent range as FP32 and doesn't need it.
    use_fp16_scaler = (
        model.loaded_precision == "fp16" and device.type == "cuda"
    )
    scaler = (
        torch.amp.GradScaler("cuda") if use_fp16_scaler
        else None
    )
    print(
        f"[train] total_optimizer_steps={total_steps}, warmup={warmup_steps}, "
        f"grad_accum={config.grad_accum_steps}, "
        f"scaler={'on' if scaler else 'off'}",
    )

    # 5) Training loop
    model.train()
    iterator = _infinite(loader)
    step = 0
    micro_step = 0
    optimizer.zero_grad(set_to_none=True)
    first_loss: float | None = None
    last_loss: float = float("nan")
    t_start = time.time()
    running_loss = 0.0
    running_infonce = 0.0
    running_ce = 0.0
    while step < total_steps:
        batch = next(iterator)
        input_ids = batch["input_ids"].to(device, non_blocking=True)
        attn = batch["attention_mask"].to(device, non_blocking=True)
        labels = batch["zone_labels"].to(device, non_blocking=True)

        # Autocast the BASE only. Heads + loss run in FP32 outside so
        # the FP16 gradient underflow window stays small (InfoNCE's
        # softmax denominator is the sensitive spot).
        autocast_dtype = {
            "fp16": torch.float16,
            "bf16": torch.bfloat16,
            "4bit-nf4-bf16": torch.bfloat16,
        }.get(model.loaded_precision or "fp32")
        if autocast_dtype is not None and device.type == "cuda":
            base_ctx = torch.autocast(
                device_type="cuda", dtype=autocast_dtype,
            )
        else:
            import contextlib
            base_ctx = contextlib.nullcontext()
        with base_ctx:
            cls_hidden = model.encode(input_ids, attn)
        out = model.heads_forward(cls_hidden)
        lout = loss_fn(
            embeddings=out["embedding"],
            zone_logits=out["zone_logits"],
            zone_labels=labels,
            per_item_stride=batch["per_item_stride"],
            neg_count=batch["neg_count"],
        )
        scaled = lout.total / config.grad_accum_steps
        if scaler is not None:
            scaler.scale(scaled).backward()
        else:
            scaled.backward()

        running_loss += lout.total.item()
        running_infonce += lout.infonce.item()
        running_ce += lout.ce.item()
        micro_step += 1

        if micro_step % config.grad_accum_steps == 0:
            if scaler is not None:
                # Unscale first so clip_grad_norm operates on real
                # gradient magnitudes, then step + update the scaler.
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(
                    trainable_params, config.grad_clip,
                )
                scaler.step(optimizer)
                scaler.update()
            else:
                torch.nn.utils.clip_grad_norm_(
                    trainable_params, config.grad_clip,
                )
                optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1

            avg_loss = running_loss / config.grad_accum_steps
            avg_infonce = running_infonce / config.grad_accum_steps
            avg_ce = running_ce / config.grad_accum_steps
            running_loss = 0.0
            running_infonce = 0.0
            running_ce = 0.0

            if first_loss is None:
                first_loss = avg_loss
            last_loss = avg_loss

            if step % config.log_every == 0 or step == 1 or step == total_steps:
                lr = scheduler.get_last_lr()[0]
                elapsed = time.time() - t_start
                gpu_mem = (
                    torch.cuda.max_memory_allocated(device) / 1024**2
                    if device.type == "cuda" else 0.0
                )
                print(
                    f"[train] step={step}/{total_steps} "
                    f"loss={avg_loss:.4f} "
                    f"infonce={avg_infonce:.4f} ce={avg_ce:.4f} "
                    f"lr={lr:.2e} "
                    f"elapsed={elapsed:.1f}s "
                    f"gpu_mb={gpu_mem:.0f}",
                )

    # 6) ONNX export — Phase 4 scope. Emit placeholder today so the
    # envelope stays valid-parsable; real export lands in a follow-up
    # PR that merges LoRA + torch.onnx.export + INT8 quantization.
    onnx_bytes = _PLACEHOLDER_ONNX
    onnx_sha = hashlib.sha256(onnx_bytes).hexdigest()
    if config.mode == "full":
        print(
            "[train] WARN: --mode full emitted placeholder ONNX; real "
            "export is Phase 4 scope. Envelope remains TS-verifiable "
            "but model.onnx bytes are not shippable.",
        )

    # 7) Eval (Phase 3 scope; smoke/full today both return sentinels).
    eval_results = empty_eval_results()

    if first_loss is None:
        first_loss = float("nan")

    return TrainResult(
        onnx_bytes=onnx_bytes,
        onnx_sha256=onnx_sha,
        tokenizer_json_bytes=tok_bytes,
        tokenizer_sha256=tok_sha,
        eval_results=eval_results,
        steps=step,
        final_loss=last_loss,
        first_loss=first_loss,
        loaded_precision=model.loaded_precision or "unknown",
        dataset_size=len(dataset),
        trainable_params=trainable_count,
        total_params=total_count,
    )
