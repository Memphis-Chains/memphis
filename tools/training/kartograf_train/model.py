"""ModernBERT-base + LoRA + two heads (embedding 256d, zone 12-class).

Forward returns a dict `{embedding, zone_logits}`. Both derived from
the [CLS] token's last hidden state. The embedding is L2-normalized so
InfoNCE can treat cos-sim == dot product. The zone head emits raw
logits (CE loss applies log_softmax internally; eval applies softmax
for probability output).

Per docs/dev/KARTOGRAF-SPEC.md §Heads:
  - EmbedHead: Linear(768, 256) + L2 normalize.
  - ZoneHead:  Linear(768, 12).

LoRA targets the fused QKV and output projection of ModernBERT's
attention layers (`Wqkv`, `Wo` in ModernBertAttention). Rank 8, alpha
16 per spec §Path A. The base encoder stays frozen (either BF16 with
requires_grad_=False, or 4-bit quantized via bitsandbytes — caller
picks); only LoRA adapters + the two heads are trainable.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from peft import LoraConfig, TaskType, get_peft_model
from transformers import AutoModel


MODEL_ID = "answerdotai/ModernBERT-base"
HIDDEN_SIZE = 768
EMBED_DIM = 256
ZONE_CLASSES = 12

# ModernBertAttention exposes `Wqkv` (fused Q/K/V) + `Wo`. These are
# the canonical LoRA injection points for this architecture; peft 0.13
# does not auto-detect them, so we pass them explicitly.
LORA_TARGET_MODULES = ["Wqkv", "Wo"]


class KartografModel(nn.Module):
    """Two-method split so the caller can put `encode` inside autocast
    and leave `heads_forward` outside. Heads run in FP32; the base can
    run in FP16/BF16 under autocast without dragging FP32 head weights
    into mixed-precision matmuls."""

    def __init__(
        self,
        base: nn.Module,
        embed_dim: int = EMBED_DIM,
        zone_classes: int = ZONE_CLASSES,
        hidden_size: int = HIDDEN_SIZE,
    ) -> None:
        super().__init__()
        self.base = base
        # Heads stay in FP32 — small matmul (768→256 and 768→12) but
        # critical for CE/InfoNCE numerical stability, especially on
        # FP16 gradient paths where underflow is a real risk.
        self.embed_head = nn.Linear(hidden_size, embed_dim, bias=False)
        self.zone_head = nn.Linear(hidden_size, zone_classes, bias=True)
        nn.init.normal_(self.embed_head.weight, std=0.02)
        nn.init.normal_(self.zone_head.weight, std=0.02)
        nn.init.zeros_(self.zone_head.bias)

    def encode(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ) -> torch.Tensor:
        """Run the base encoder and return the [CLS] hidden state.
        Call this INSIDE `torch.autocast(...)` on half-precision paths."""
        outputs = self.base(
            input_ids=input_ids,
            attention_mask=attention_mask,
            return_dict=True,
        )
        return outputs.last_hidden_state[:, 0, :]

    def heads_forward(self, cls_hidden: torch.Tensor) -> dict[str, torch.Tensor]:
        """Apply embed + zone heads. Call OUTSIDE autocast so the FP32
        head weights operate on FP32 input (we cast here)."""
        x = cls_hidden.float()
        embedding = self.embed_head(x)
        embedding = F.normalize(embedding, p=2, dim=-1)
        zone_logits = self.zone_head(x)
        return {"embedding": embedding, "zone_logits": zone_logits}

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ) -> dict[str, torch.Tensor]:
        """Convenience for eval / unit tests; the training loop should
        use encode()+heads_forward() directly to control precision."""
        return self.heads_forward(self.encode(input_ids, attention_mask))


def _bnb_supported() -> bool:
    """Return True iff current CUDA device is Turing (CC 7.5) or newer.

    bitsandbytes 0.49 NF4 kernels rely on tensor-core / ptx features
    that Maxwell (CC 5.x, e.g. GTX 960) and Pascal (CC 6.x) lack.
    Attempting 4-bit load on those cards crashes deep in the CUDA
    driver with `Error named symbol not found at line 62 in file
    /src/csrc/ops.cu` — not a Python exception we can catch cleanly.
    Gate explicitly on compute capability rather than hoping the
    try/except catches it.
    """
    if not torch.cuda.is_available():
        return False
    major, minor = torch.cuda.get_device_capability(0)
    return (major, minor) >= (7, 5)


def _pick_attn_impl() -> str:
    """ModernBERT defaults to 'flash_attention_2' or SDPA when available;
    both pull in Triton codegen that requires CC >= 7.0. On older cards
    (Maxwell / Pascal) pin to `eager` — slower but correctness-first.
    """
    if torch.cuda.is_available():
        major, _ = torch.cuda.get_device_capability(0)
        if major < 7:
            return "eager"
    # Use SDPA by default on modern GPUs (native PyTorch, no Triton
    # dependency, widely compatible).
    return "sdpa"


def build_model(
    prefer_4bit: bool = True,
    gradient_checkpointing: bool = False,
) -> KartografModel:
    """Instantiate ModernBERT-base + LoRA + heads.

    4-bit loading is attempted only on CUDA devices with compute
    capability >= 7.5 (Turing+). Older cards (Maxwell/Pascal) fall
    back to BF16 — the base (~300 MB) fits in 4 GB VRAM alongside
    activations + LoRA + optimizer state for the GTX 960 profile. The
    returned model reports the actual path via `.loaded_precision`.
    """
    base = None
    loaded_precision: str | None = None
    if prefer_4bit:
        if not torch.cuda.is_available():
            pass  # CPU — precision logic below picks float32
        elif not _bnb_supported():
            major, minor = torch.cuda.get_device_capability(0)
            print(
                f"[model] CUDA device has compute capability {major}.{minor}; "
                f"bitsandbytes NF4 requires >=7.5 (Turing). Falling back to "
                f"half-precision without 4-bit quantization.",
            )
        else:
            try:
                from transformers import BitsAndBytesConfig
                bnb_cfg = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=torch.bfloat16,
                    bnb_4bit_use_double_quant=True,
                    bnb_4bit_quant_type="nf4",
                )
                base = AutoModel.from_pretrained(
                    MODEL_ID,
                    quantization_config=bnb_cfg,
                    torch_dtype=torch.bfloat16,
                    attn_implementation=_pick_attn_impl(),
                    # ModernBERT wraps `compiled_embeddings` in
                    # torch.compile when this is True (default). The
                    # wrapper survives dynamo.config.disable=True
                    # (it's a structural change to the module tree),
                    # which crashes torch.onnx.export with "FX to
                    # torch.jit.trace a dynamo-optimized function".
                    # Force-off so embeddings stay plain Python.
                    reference_compile=False,
                )
                loaded_precision = "4bit-nf4-bf16"
            except Exception as exc:
                # Even on supported hardware, peft's fused-QKV wrapper can
                # misbehave against specific bnb versions. If load raises
                # cleanly, fall back to BF16; kernel-level crashes are
                # pre-filtered by the capability gate above.
                print(f"[model] 4-bit load failed ({exc}); falling back to BF16")
                base = None

    if base is None:
        # Maxwell (CC 5.x) + Pascal (CC 6.x) lack native BF16; torch
        # up-casts under the hood and activations balloon. Use FP16 on
        # those cards instead — it's the oldest native half-precision
        # supported (FP16 storage since Fermi, FP16 compute since
        # Maxwell 2). Turing+ gets true BF16.
        if torch.cuda.is_available():
            major, _ = torch.cuda.get_device_capability(0)
            if major < 7:
                dtype = torch.float16
                loaded_precision = "fp16"
            else:
                dtype = torch.bfloat16
                loaded_precision = "bf16"
        else:
            dtype = torch.float32
            loaded_precision = "fp32"
        base = AutoModel.from_pretrained(
            MODEL_ID,
            torch_dtype=dtype,
            attn_implementation=_pick_attn_impl(),
            reference_compile=False,
        )

    if gradient_checkpointing:
        # Trade compute for memory: halves activation RAM per layer by
        # re-running the forward during backward. On GTX 960 4 GB this
        # is the difference between OOM at seq=512 and comfortable
        # batches. Must be called BEFORE peft-wrapping so the Module
        # tree is still the transformers base.
        if hasattr(base, "gradient_checkpointing_enable"):
            base.gradient_checkpointing_enable(
                gradient_checkpointing_kwargs={"use_reentrant": False},
            )

    # Apply LoRA on top of the (possibly quantized) base.
    lora_cfg = LoraConfig(
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        bias="none",
        target_modules=LORA_TARGET_MODULES,
        task_type=TaskType.FEATURE_EXTRACTION,
    )
    base = get_peft_model(base, lora_cfg)
    # Force LoRA adapter params to FP32 so the optimizer + GradScaler
    # path is stable on FP16 half-precision training (Maxwell). peft's
    # wrapper handles the adapter-vs-base dtype gap at the linear
    # output summation boundary via autocast. Adapter cost is ~1 M
    # params => ~4 MB in FP32; trivial.
    for name, param in base.named_parameters():
        if "lora_" in name and param.requires_grad:
            param.data = param.data.float()
    base.print_trainable_parameters()

    model = KartografModel(base=base)
    model.loaded_precision = loaded_precision  # type: ignore[attr-defined]
    return model


def count_trainable_params(model: nn.Module) -> tuple[int, int]:
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    return trainable, total
