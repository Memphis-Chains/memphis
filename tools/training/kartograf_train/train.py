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
from .eval import EvalResults, empty_eval_results, format_eval_line, run_eval
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
    # Bumped from 1 → 4 so in-batch InfoNCE negatives actually exist:
    # at B=1 every "step" has just one anchor and the contrastive task
    # collapses to 5-way (1 pos + K negs); at B=4 the model competes
    # against 4*(1+K) = 20-way per anchor (own pos + K hard + 3 other
    # anchors' positives + 3*K other anchors' hard negs). Grad accum
    # adjusted below to keep effective batch identical.
    batch_size: int = 4           # anchors per step; each drags 2+K items
    # Smoke defaults to 128 to fit GTX 960 VRAM with 6-sample forward
    # batch (1 anchor + 1 positive + 4 hard negs). Full mode overrides
    # to 512 per spec §Training paths. Memphis chain content is mostly
    # under 100 tokens anyway; doc/code samples are the long ones.
    max_length: int = 128
    # Eval knobs. Full-mode defaults to eval-per-epoch; smoke skips.
    run_epoch_eval: bool = True
    eval_batch_size: int = 8
    eval_max_length: int = 256  # matches augmented chunks better than 128
    # On a 4 GB card seq=512 with per_item_stride=6 OOMs; grad_checkpointing
    # halves activation RAM for ~30% more compute. Full mode defaults on.
    gradient_checkpointing: bool = True
    lr: float = 1e-4
    weight_decay: float = 0.01
    warmup_ratio: float = 0.05
    lambda_infonce: float = 1.0
    lambda_ce: float = 0.5
    # 0.07 over-sharpens softmax once in-batch negatives widen the
    # candidate pool to ~B*(1+K) (~40-way at B=8, K=4); 0.1 keeps the
    # contrastive gradient informative across more candidates.
    temperature: float = 0.1
    grad_accum_steps: int = 2     # effective batch = batch_size * grad_accum = 8
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
    if config.run_epoch_eval and config.mode != "smoke":
        eval_target = len(bundle.eval_samples)
        print(f"[train] eval set: {eval_target} samples")
    else:
        eval_target = 0
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
    model = build_model(
        prefer_4bit=config.prefer_4bit,
        gradient_checkpointing=config.gradient_checkpointing,
    ).to(device)
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
        steps_per_epoch = total_steps  # smoke is one pseudo-epoch
    else:
        # Each DataLoader iteration covers one pass over anchors. We
        # accumulate gradients across `grad_accum_steps` micro-batches
        # GLOBALLY, not per-epoch — flooring per-epoch independently
        # then multiplying by epochs under-budgets total optimizer
        # updates whenever iters_per_epoch is not divisible by
        # grad_accum_steps. Compute the true budget first, then derive
        # per-epoch boundary for the eval hook.
        iters_per_epoch = max(1, len(dataset) // config.batch_size)
        total_steps = max(
            1,
            (config.epochs * iters_per_epoch) // config.grad_accum_steps,
        )
        steps_per_epoch = max(1, total_steps // config.epochs)
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
        f"steps_per_epoch={steps_per_epoch}, "
        f"scaler={'on' if scaler else 'off'}",
    )

    # Best-eval tracking. We keep the trainable params' state_dict in
    # memory (LoRA adapters + heads only, ~5-50 MB) and restore at the
    # end so the returned checkpoint is the best-on-eval, not the last.
    best_eval: EvalResults | None = None
    best_state: dict | None = None

    def _do_epoch_eval(epoch_idx: int) -> None:
        nonlocal best_eval, best_state
        if not config.run_epoch_eval or config.mode == "smoke":
            return
        if not bundle.eval_samples:
            return
        eval_t0 = time.time()
        results = run_eval(
            model=model,
            tokenizer=tokenizer,
            bundle=bundle,
            eval_samples=bundle.eval_samples,
            # Eval-side pairs (anchor+positive both inside the eval bank).
            # Falls back to bundle.pairs_by_sha for backwards compat if
            # eval-pairs.jsonl wasn't generated, but recall@K is then
            # structurally 0 — see CorpusBundle.eval_pairs_by_sha doc.
            pairs_by_sha=bundle.eval_pairs_by_sha or bundle.pairs_by_sha,
            device=device,
            max_length=config.eval_max_length,
            batch_size=config.eval_batch_size,
        )
        print(
            f"[train] epoch {epoch_idx}/{config.epochs} {format_eval_line(results)} "
            f"(eval took {time.time() - eval_t0:.1f}s)",
        )
        # Best = highest recall@10 (primary spec threshold).
        if best_eval is None or results.retrieval_recall_at_10 > best_eval.retrieval_recall_at_10:
            best_eval = results
            # Snapshot trainable params only — base encoder is frozen by
            # peft (LoRA), saving it would quadruple the snapshot size.
            best_state = {
                name: p.detach().cpu().clone()
                for name, p in model.named_parameters() if p.requires_grad
            }
            print(f"[train]   new best recall@10={results.retrieval_recall_at_10:.4f}")
        model.train()  # run_eval flipped to eval() mode

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

            # End-of-epoch hook. When total_steps is not divisible by
            # epochs (small/pathological corpora), `step // steps_per_epoch`
            # can exceed config.epochs near the end of training and fire
            # extra "epoch N+1/N" evals; gate by config.epochs so we
            # always fire exactly `epochs` evals at well-spaced points.
            if (
                steps_per_epoch > 0
                and step % steps_per_epoch == 0
                and step // steps_per_epoch <= config.epochs
            ):
                epoch_idx = step // steps_per_epoch
                _do_epoch_eval(epoch_idx)

    # If we tracked a best-eval snapshot, restore it before export so
    # the shipped checkpoint is best-on-eval, not last-step.
    if best_state is not None:
        with torch.no_grad():
            for name, p in model.named_parameters():
                if name in best_state:
                    p.data.copy_(best_state[name].to(p.device))
        print("[train] restored best-on-eval state_dict")

    # Persist the trainable params snapshot to disk regardless of ONNX
    # success. Saved BEFORE export so a crash there doesn't lose the
    # entire training run; operators can rerun the standalone exporter
    # against this file.
    if config.mode != "smoke":
        config.out_dir.mkdir(parents=True, exist_ok=True)
        state_to_save = best_state if best_state is not None else {
            name: p.detach().cpu().clone()
            for name, p in model.named_parameters() if p.requires_grad
        }
        state_path = config.out_dir / "best_state.pt"
        torch.save(state_to_save, state_path)
        print(f"[train] saved trainable state_dict to {state_path}")

    # 6) ONNX export — real in full mode, placeholder in smoke.
    if config.mode == "smoke":
        onnx_bytes = _PLACEHOLDER_ONNX
    else:
        from .onnx_export import export_model_to_onnx
        try:
            onnx_bytes = export_model_to_onnx(
                model=model,
                tokenizer=tokenizer,
                device=device,
                max_length=config.max_length,
            )
        except Exception as exc:
            # Export bugs shouldn't block shipping a trained checkpoint.
            # Fall back to placeholder so envelope stays valid; operator
            # can run the standalone export tool offline.
            saved_state = config.out_dir / "best_state.pt"
            print(
                f"[train] WARN: ONNX export failed ({type(exc).__name__}: {exc}); "
                f"emitting placeholder. Best state_dict was saved to "
                f"{saved_state}; retry export offline by reloading "
                f"build_model() + state_dict and calling "
                f"kartograf_train.onnx_export.export_model_to_onnx() directly.",
            )
            onnx_bytes = _PLACEHOLDER_ONNX
    onnx_sha = hashlib.sha256(onnx_bytes).hexdigest()

    # 7) Eval — in smoke mode skip; in full mode report best-epoch eval
    # (or run one now if the eval hook never fired).
    if config.mode == "smoke" or not config.run_epoch_eval:
        eval_results = empty_eval_results()
    elif best_eval is not None:
        eval_results = best_eval
    else:
        # run_epoch_eval was on but eval set was empty or hook never
        # triggered; do one pass now for parity.
        if bundle.eval_samples:
            eval_results = run_eval(
                model=model, tokenizer=tokenizer, bundle=bundle,
                eval_samples=bundle.eval_samples,
                pairs_by_sha=bundle.eval_pairs_by_sha or bundle.pairs_by_sha,
                device=device,
                max_length=config.eval_max_length,
                batch_size=config.eval_batch_size,
            )
        else:
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
