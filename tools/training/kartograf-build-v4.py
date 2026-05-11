#!/usr/bin/env python3
"""Build Kartograf v4 corpus — merge v3 + MSE + wide-window chat candidates.

Output: ~/.memphis/kartograf/corpus/v4/{train,eval,zone-labels,summary}.jsonl

Source weighting strategy:
  - v3 baseline (3507 entries): chain blocks + augmented (Rust/TS Handbook)
  - MSE (480 entries): zone-labeled chain content from memory_search_entries SQLite table
  - Wide-window chat (1486 entries): operator/bot chat msgs, zone=journal

Dedup by sha256 of content. Eval split: 90/10 stratified by zone.
"""
import json, hashlib, random
from pathlib import Path
from collections import Counter, defaultdict

random.seed(42)
HOME = Path.home()
V3 = HOME / '.memphis/kartograf/corpus/v3'
V4 = HOME / '.memphis/kartograf/corpus/v4'
V4.mkdir(parents=True, exist_ok=True)

WIDE = HOME / 'memphis/data/training/wide-window-2026-04-01_to_2026-05-11/raw/kartograf-candidates-v4.jsonl'
MSE = HOME / 'memphis/data/training/max-2026-05-11/raw/kartograf-corpus-from-mse.jsonl'
ZONE_LABELS_SRC = V3 / 'zone-labels.json'

def load_jsonl(p):
    out = []
    for line in Path(p).read_text().splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out

print('Loading sources...')
v3_train = load_jsonl(V3 / 'train.jsonl')
v3_eval = load_jsonl(V3 / 'eval.jsonl')
mse = load_jsonl(MSE)
wide = load_jsonl(WIDE)

print(f'  v3 train: {len(v3_train)}')
print(f'  v3 eval:  {len(v3_eval)}')
print(f'  MSE:      {len(mse)}')
print(f'  wide:     {len(wide)}')

# Normalize: strip non-canonical metadata keys, keep schema fields
CANON = {'sha256', 'source_path', 'zone', 'content', 'license', 'mutability', 'ambiguous'}

def normalize(d):
    out = {k: d[k] for k in CANON if k in d}
    # Recompute sha256 from content (avoid stale)
    out['sha256'] = hashlib.sha256(out['content'].encode('utf-8')).hexdigest()
    # Defaults
    out.setdefault('license', 'operator:local-only')
    out.setdefault('mutability', 0.5)
    out.setdefault('ambiguous', False)
    return out

# Merge with priority: v3 first (existing), then MSE, then wide (new)
seen = {}
order = []
zone_counter = Counter()

for src, src_label in [(v3_train, 'v3_train'), (v3_eval, 'v3_eval'),
                        (mse, 'mse'), (wide, 'wide')]:
    n_added = 0
    n_skip_dup = 0
    n_skip_zone = 0
    for d in src:
        # Skip if missing required fields
        if 'content' not in d or 'zone' not in d:
            n_skip_zone += 1
            continue
        # Skip if zone not in valid taxonomy
        if d['zone'] not in {'journal','decisions','reflections','cases',
                              'patterns','system','collective','proactive',
                              'insights','soul','reserved_1','reserved_2'}:
            n_skip_zone += 1
            continue
        nd = normalize(d)
        if len(nd['content']) < 30:
            continue
        sig = nd['sha256']
        if sig in seen:
            n_skip_dup += 1
            continue
        seen[sig] = nd
        nd['_source_layer'] = src_label  # debug field
        order.append(sig)
        zone_counter[nd['zone']] += 1
        n_added += 1
    print(f'  {src_label}: +{n_added} added, -{n_skip_dup} dups, -{n_skip_zone} bad-zone')

print(f'\nTotal merged: {len(order)} unique samples')
print(f'Zone distribution:')
for z, n in sorted(zone_counter.items(), key=lambda x: -x[1]):
    pct = 100 * n / len(order)
    print(f'  {z:15s} {n:5d}  ({pct:.1f}%)')

# Eval split: 10% per-zone stratified
by_zone = defaultdict(list)
for sig in order:
    by_zone[seen[sig]['zone']].append(sig)

eval_set = set()
for zone, sigs in by_zone.items():
    n_eval = max(1, len(sigs) // 10)
    random.shuffle(sigs)
    eval_set.update(sigs[:n_eval])

train_samples = [seen[sig] for sig in order if sig not in eval_set]
eval_samples = [seen[sig] for sig in order if sig in eval_set]

# Strip debug field from output
for lst in (train_samples, eval_samples):
    for d in lst:
        d.pop('_source_layer', None)

# Write
train_path = V4 / 'train.jsonl'
eval_path = V4 / 'eval.jsonl'
with train_path.open('w') as f:
    for d in train_samples:
        f.write(json.dumps(d, ensure_ascii=False) + '\n')
with eval_path.open('w') as f:
    for d in eval_samples:
        f.write(json.dumps(d, ensure_ascii=False) + '\n')

# Copy zone-labels.json from v3
import shutil
shutil.copy(ZONE_LABELS_SRC, V4 / 'zone-labels.json')

# Summary
summary = {
    'corpus_version': 'v4',
    'parent_corpus_version': 'v3',
    'generated_at': '2026-05-11',
    'source_count': len(order),
    'split': {'train': len(train_samples), 'eval': len(eval_samples)},
    'sources': {
        'v3_train': len(v3_train),
        'v3_eval': len(v3_eval),
        'mse_sqlite': len(mse),
        'wide_window_chat': len(wide),
    },
    'per_zone_counts': dict(zone_counter),
    'merge_strategy': 'sha256 content dedup; priority v3 > MSE > wide; eval 10% per-zone stratified',
    'augmentation_intent': 'add operator chat trajectory + fresh chain MSE indexed content to v3 baseline',
}
(V4 / 'corpus-v1-summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False))

print(f'\n=== WROTE ===')
print(f'  {train_path}: {train_path.stat().st_size/1024:.1f}KB ({len(train_samples)} samples)')
print(f'  {eval_path}:  {eval_path.stat().st_size/1024:.1f}KB ({len(eval_samples)} samples)')
print(f'  {V4 / "corpus-v1-summary.json"}: summary')
print(f'  {V4 / "zone-labels.json"}: copied from v3')
