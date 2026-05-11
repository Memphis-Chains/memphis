#!/usr/bin/env python3
"""V2 — workarounds for 4GB VRAM training OOM:
  - gradient_checkpointing_enable()
  - BS=1 or 2
  - SEQ=256 (half)
  - 8-bit optimizer (Adam8bit via bitsandbytes if available)
  - Smaller models as fallback (DistilBERT)
"""
import gc, os, time
import torch
import torch.nn as nn

os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')

def fmt_mb(b): return f'{b/1024/1024:.0f}MB'

def cleanup():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

def train_bench(model_id, device, bs_list, seq_len, grad_ckpt=False, opt_8bit=False):
    from transformers import AutoModel, AutoTokenizer
    from peft import LoraConfig, get_peft_model

    print(f'\n=== {model_id} | grad_ckpt={grad_ckpt} opt_8bit={opt_8bit} SEQ={seq_len} ===')
    try:
        tok = AutoTokenizer.from_pretrained(model_id)
        base = AutoModel.from_pretrained(model_id)
    except Exception as e:
        print(f'  LOAD FAIL: {e}'); return

    n_params = sum(p.numel() for p in base.parameters())
    print(f'  params: {n_params/1e6:.1f}M  hidden: {base.config.hidden_size}')

    if grad_ckpt:
        base.gradient_checkpointing_enable()

    target_modules = []
    for name, _ in base.named_modules():
        if name.endswith(('query_proj', 'key_proj', 'value_proj', 'query', 'key', 'value')):
            target_modules.append(name.split('.')[-1])
    target_modules = list(set(target_modules)) or ['query', 'key', 'value']

    cfg = LoraConfig(r=8, lora_alpha=16, target_modules=target_modules,
                     lora_dropout=0.05, task_type='FEATURE_EXTRACTION')
    model = get_peft_model(base, cfg).to(device)
    if grad_ckpt:
        # Need to also re-enable on peft wrapper
        model.base_model.model.gradient_checkpointing_enable()
        # PEFT requires inputs to require grads when grad_ckpt is on
        if hasattr(model, 'enable_input_require_grads'):
            model.enable_input_require_grads()

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f'  trainable: {trainable/1e6:.2f}M / {total/1e6:.1f}M ({100*trainable/total:.2f}%)')

    head = nn.Linear(base.config.hidden_size, 256).to(device)
    params = [p for p in model.parameters() if p.requires_grad] + list(head.parameters())

    if opt_8bit:
        try:
            import bitsandbytes as bnb
            opt = bnb.optim.AdamW8bit(params, lr=1e-4)
            print(f'  optim: AdamW8bit (bnb)')
        except ImportError:
            print(f'  bitsandbytes not installed, falling back AdamW FP32')
            opt = torch.optim.AdamW(params, lr=1e-4)
    else:
        opt = torch.optim.AdamW(params, lr=1e-4)

    text = ('Memphis Agent runtime block: append-only chain integrity '
            'vault tier3 elevation tool dispatch ') * 50

    for bs in bs_list:
        cleanup()
        try:
            enc = tok(text, return_tensors='pt', truncation=True,
                      max_length=seq_len, padding='max_length').to(device)
            enc = {k: v.repeat(bs, 1) for k, v in enc.items()}
            model.train()
            for _ in range(2):
                opt.zero_grad()
                out = model(**enc)
                emb = head(out.last_hidden_state[:, 0])
                loss = emb.mean()
                loss.backward()
                opt.step()
            torch.cuda.synchronize()
            t0 = time.perf_counter()
            for _ in range(5):
                opt.zero_grad()
                out = model(**enc)
                emb = head(out.last_hidden_state[:, 0])
                loss = emb.mean()
                loss.backward()
                opt.step()
            torch.cuda.synchronize()
            dt = (time.perf_counter() - t0) / 5
            peak = torch.cuda.max_memory_allocated()
            print(f'  TRAIN BS={bs}: {dt*1000:.0f}ms = {bs/dt:.2f} samples/s, peak {fmt_mb(peak)}')
        except torch.cuda.OutOfMemoryError:
            print(f'  TRAIN BS={bs}: OOM')
            cleanup()
            continue

    del model, base, head, opt
    cleanup()

def main():
    if not torch.cuda.is_available():
        print('NO CUDA'); return
    device = torch.device('cuda:0')
    free, total = torch.cuda.mem_get_info()
    print(f'CUDA OK: {torch.cuda.get_device_name(0)} | free {fmt_mb(free)} / total {fmt_mb(total)}')

    # Try progressively: BS=2/1 with gradient checkpointing
    candidates = [
        ('microsoft/deberta-v3-base', 'kartograf-base class (184M)'),
        ('microsoft/deberta-v3-large', 'kartograf-large class (304M)'),
    ]
    for mid, desc in candidates:
        print(f'\n========= {desc} =========')
        # Pass 1: short seq + no ckpt
        train_bench(mid, device, bs_list=[2, 1], seq_len=256, grad_ckpt=False)
        # Pass 2: long seq + grad ckpt
        train_bench(mid, device, bs_list=[4, 2, 1], seq_len=512, grad_ckpt=True)

if __name__ == '__main__':
    main()
