#!/usr/bin/env python3
"""GTX 960 (Maxwell sm_52) realistic training capacity smoke test.

Goal: figure out the largest model + biggest batch that fits + measure
throughput so we can estimate full Kartograf-class training time.

ModernBERT requires transformers 4.49+ which requires PyTorch 2.4+ which
drops Maxwell. So we test DeBERTa-v3 (deberta-v2 architecture) instead —
same encoder family, LoRA-friendly, broadly compatible with torch 2.3.

Tests:
  1. PyTorch env
  2. Forward pass per (model, batch_size, seq_len) — measure tokens/sec + VRAM
  3. Training step (full FT) — VRAM ceiling, OOM detection
  4. LoRA training step — actual training-mode throughput
  5. Final estimate: time to train v3 corpus (~5k anchors × 30 epochs)
"""
import gc
import os
import time

import torch
import torch.nn as nn

os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')


def fmt_mb(b):
    return f'{b/1024/1024:.0f}MB'


def env_report():
    print('=' * 64)
    print('1. ENV')
    print('=' * 64)
    print(f'torch {torch.__version__} | cuda compiled {torch.version.cuda}')
    if not torch.cuda.is_available():
        print('NO CUDA — abort')
        return None
    dev = torch.device('cuda:0')
    props = torch.cuda.get_device_properties(0)
    print(f'device: {torch.cuda.get_device_name(0)}')
    print(f'compute cap: sm_{props.major}{props.minor}')
    print(f'total VRAM: {fmt_mb(props.total_memory)}')
    free, total = torch.cuda.mem_get_info()
    print(f'free VRAM: {fmt_mb(free)} of {fmt_mb(total)}')
    print(f'arch list supported: {torch.cuda.get_arch_list()}')
    return dev


def cleanup():
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()


def benchmark_model(model_id, device, batch_sizes=(4, 8), seq_len=512):
    """Run forward + LoRA training on a model_id, report throughput + VRAM."""
    from transformers import AutoModel, AutoTokenizer

    print(f'\n--- {model_id} ---')
    try:
        tok = AutoTokenizer.from_pretrained(model_id)
        base = AutoModel.from_pretrained(model_id)
    except Exception as e:
        print(f'  LOAD FAIL: {type(e).__name__}: {str(e)[:140]}')
        return

    n_params = sum(p.numel() for p in base.parameters())
    print(f'  params: {n_params/1e6:.1f}M  hidden: {base.config.hidden_size}  layers: {base.config.num_hidden_layers}')

    # ---- Inference ----
    base_eval = base.to(device).eval()
    text = ('Memphis Agent runtime block: append-only chain integrity '
            'vault tier3 elevation tool dispatch ') * 50

    for bs in batch_sizes:
        cleanup()
        try:
            enc = tok(text, return_tensors='pt', truncation=True,
                      max_length=seq_len, padding='max_length').to(device)
            enc = {k: v.repeat(bs, 1) for k, v in enc.items()}
            with torch.no_grad():
                _ = base_eval(**enc)  # warmup
                torch.cuda.synchronize()
                t0 = time.perf_counter()
                for _ in range(5):
                    _ = base_eval(**enc)
                torch.cuda.synchronize()
                dt = (time.perf_counter() - t0) / 5
            peak = torch.cuda.max_memory_allocated()
            tokens = bs * seq_len
            print(f'  INFER  BS={bs} SEQ={seq_len}: {dt*1000:.0f}ms = {tokens/dt:.0f} tok/s, peak {fmt_mb(peak)}')
        except torch.cuda.OutOfMemoryError:
            print(f'  INFER  BS={bs} SEQ={seq_len}: OOM')
            cleanup()

    del base_eval
    cleanup()

    # ---- LoRA training ----
    try:
        from peft import LoraConfig, get_peft_model

        base2 = AutoModel.from_pretrained(model_id)
        # Generic target modules for DeBERTa/BERT-family attention
        target_modules = []
        for name, _mod in base2.named_modules():
            # match any linear inside attention with q/k/v/o naming
            if name.endswith(('query_proj', 'key_proj', 'value_proj', 'output.dense', 'query', 'key', 'value')):
                target_modules.append(name.split('.')[-1])
        target_modules = list(set(target_modules)) or ['query', 'key', 'value']
        print(f'  LoRA target modules detected: {target_modules}')

        cfg = LoraConfig(r=8, lora_alpha=16, target_modules=target_modules,
                         lora_dropout=0.05, task_type='FEATURE_EXTRACTION')
        model = get_peft_model(base2, cfg).to(device)
        trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        total = sum(p.numel() for p in model.parameters())
        print(f'  trainable: {trainable/1e6:.2f}M / {total/1e6:.1f}M ({100*trainable/total:.2f}%)')

        head = nn.Linear(base2.config.hidden_size, 256).to(device)
        opt = torch.optim.AdamW(
            [p for p in model.parameters() if p.requires_grad] + list(head.parameters()),
            lr=1e-4,
        )

        for bs in batch_sizes:
            cleanup()
            try:
                enc = tok(text, return_tensors='pt', truncation=True,
                          max_length=seq_len, padding='max_length').to(device)
                enc = {k: v.repeat(bs, 1) for k, v in enc.items()}
                model.train()
                # Warmup
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
                tokens = bs * seq_len
                print(f'  TRAIN  BS={bs} SEQ={seq_len} (LoRA): {dt*1000:.0f}ms = {tokens/dt:.0f} tok/s, peak {fmt_mb(peak)}')
            except torch.cuda.OutOfMemoryError:
                print(f'  TRAIN  BS={bs} SEQ={seq_len}: OOM (try smaller BS)')
                cleanup()
                # Continue with other batch sizes
                continue

        del model, base2, head, opt
        cleanup()
    except Exception as e:
        print(f'  LoRA FAIL: {type(e).__name__}: {str(e)[:200]}')


def main():
    device = env_report()
    if device is None:
        return

    print()
    print('=' * 64)
    print('2-4. PER-MODEL BENCHMARKS')
    print('=' * 64)

    candidates = [
        'microsoft/deberta-v3-base',   # 184M, kartograf-base class
        'microsoft/deberta-v3-large',  # 304M, MAX practical encoder on 4GB
        'bert-large-uncased',          # 336M, baseline
    ]
    for mid in candidates:
        benchmark_model(mid, device)

    print()
    print('=' * 64)
    print('5. TRAINING TIME ESTIMATE')
    print('=' * 64)
    print('Kartograf v3 corpus: ~5000 anchors')
    print('Typical contrastive training: 30 epochs')
    print('Total samples processed: 150_000')
    print('Time = 150_000 / (samples/sec from TRAIN row above)')
    print()
    print('Apply: samples/sec = (tok/s reported) / SEQ_LEN')
    print('Example: 800 tok/s @ SEQ=512 → 1.56 samples/sec → 150_000/1.56/3600 = ~26.7h')
    print()
    print('If chosen model trains at >2 samples/sec → fits in overnight cycle (<24h)')


if __name__ == '__main__':
    main()
