"""Synthetic architecture preflight. Never signs or activates a model."""
import argparse
import json
import os
import sys
from pathlib import Path
parser = argparse.ArgumentParser(description='Offline random-model GPU/ONNX preflight; no release checkpoint')
parser.add_argument('--tokenizer-dir', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
p = args.out.resolve()
p.mkdir(mode=448, parents=True, exist_ok=False)
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['KARTOGRAF_HIDDEN_SIZE'] = '32'
os.environ['KARTOGRAF_LORA_TARGETS'] = 'Wqkv,Wo'
sys.path.insert(0, str(Path(__file__).resolve().parent))
import torch
import transformers, peft
from transformers import AutoTokenizer, ModernBertConfig, ModernBertModel
print('versions', torch.__version__, transformers.__version__, peft.__version__, flush=True)
if not torch.cuda.is_available():
    raise RuntimeError('CUDA GPU required for this preflight')
tokenizer = AutoTokenizer.from_pretrained(args.tokenizer_dir.resolve(), local_files_only=True)
texts = ['', 'Ala ma kota. Zażółć gęślą jaźń.', 'Memphis\n\tOAuth — commit #688: a/b != c.', '日本語 👩🏽\u200d💻 العربية café é', '[CLS] [SEP] <s> <|endoftext|>', 'hello ' * 700]
cases = []
for text in texts:
    enc = tokenizer(text, padding=False, truncation=True, max_length=512)
    cases.append({'text': text, 'input_ids': enc['input_ids'], 'attention_mask': enc['attention_mask']})
(p / 'python-tokenizer-cases.json').write_text(json.dumps(cases, ensure_ascii=False))
torch.manual_seed(42)
fixture = p / 'tiny-ModernBERT-random-fixture'
config = ModernBertConfig(vocab_size=len(tokenizer), hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=4, max_position_embeddings=512, local_attention=32, global_attn_every_n_layers=2, reference_compile=False, attn_implementation='eager', pad_token_id=tokenizer.pad_token_id)
base = ModernBertModel(config)
base.save_pretrained(fixture)
from kartograf_train.model import build_model
model = build_model(prefer_4bit=False, model_id=str(fixture)).to('cuda')
model.train()
batch = tokenizer(['Ala ma kota.', 'Kot na kanapie.', 'Rust compiler error.', 'Memphis stores memory.', 'Memory in Memphis.', 'A shopping list.'], padding=True, return_tensors='pt')
batch = {k: v.cuda() for k, v in batch.items() if k in ('input_ids', 'attention_mask')}
opt = torch.optim.AdamW([x for x in model.parameters() if x.requires_grad], lr=0.0001)
with torch.autocast(device_type='cuda', dtype=torch.float16):
    h = model.encode(**batch)
out = model.heads_forward(h)
from kartograf_train.loss import KartografLoss
criterion = KartografLoss(torch.ones(12, device='cuda'))
loss = criterion(out['embedding'], out['zone_logits'], torch.tensor([0, 3], device='cuda'), per_item_stride=3, neg_count=1).total
assert torch.isfinite(loss), 'Non-finite training loss'
loss.backward()
grads = [x.grad for n, x in model.named_parameters() if 'lora_' in n and x.grad is not None]
assert grads and all((torch.isfinite(x).all() for x in grads)) and any((torch.count_nonzero(x) > 0 for x in grads))
opt.step()
result = {'fixtureOnly': True, 'pretrainedWeightsDownloaded': False, 'torch': torch.__version__, 'transformers': transformers.__version__, 'peft': peft.__version__, 'precision': model.loaded_precision, 'loss': loss.item(), 'loraGradientTensors': len(grads), 'peakGpuAllocated': torch.cuda.max_memory_allocated()}
(p / 'gpu-training-probe.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result), flush=True)
from kartograf_train.onnx_export import export_model_to_onnx
raw = export_model_to_onnx(model, tokenizer, torch.device('cpu'))
(p / 'tiny-model.onnx').write_bytes(raw)
print('export bytes', len(raw), flush=True)
import onnxruntime as ort
session = ort.InferenceSession(raw, providers=['CPUExecutionProvider'])
for case in cases:
    import numpy as np
    embedding, logits = session.run(['embedding', 'zone_logits'], {'input_ids': np.array([case['input_ids']], dtype=np.int64), 'attention_mask': np.array([case['attention_mask']], dtype=np.int64)})
    case['embedding'] = embedding[0].tolist()
    case['zone_logits'] = logits[0].tolist()
(p / 'python-tokenizer-cases.json').write_text(json.dumps(cases, ensure_ascii=False))
result['exportBytes'] = len(raw)
result['onnxParityCases'] = 5
result['pythonInferenceCases'] = len(cases)
(p / 'gpu-training-probe.json').write_text(json.dumps(result, indent=2))
