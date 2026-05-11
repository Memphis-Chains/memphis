#!/usr/bin/env python3
"""Curate trajectory data: tag, dedup, balance, extract negatives, split.

Input: raw/tool-calls.jsonl + raw/trajectories.jsonl
Output: curated/{trajectory,tool-selection,negatives}-{train,eval}.jsonl + stats.json

Curation philosophy: TAG not DROP. Preserve all data, label per-quality.
Downstream filter at train time based on `_quality` and `_thinking_len`.

Tags applied per turn:
  _quality:
    - 'full': thinking >=20 chars AND tool_results all succeeded
    - 'thin': thinking <20 chars OR empty
    - 'failed': any tool_result error/non-zero exit
  _thinking_len: char count of assistant_thinking after strip()
  _category: tool category (action/codemod/introspection/search/unknown)
  _dominant_tool: first tool name in sequence

Dedup rule: drop EXACT (user_input + tool_names_sorted + tool_args_sorted)
duplicates. Different sequences with same (user, tools, args) are likely
retries — keep first.

Balance: cap memphis_exec at <=40% of curated set (loose cap, since data is exec-biased).
"""
import json, hashlib, random
from pathlib import Path
from collections import Counter, defaultdict

random.seed(42)
ROOT = Path('/home/memphis/memphis/data/training/anthropic-window-2026-05-10')
RAW = ROOT / 'raw'
OUT = ROOT / 'curated'

TOOL_CATEGORY = {
    'memphis_exec': 'action',
    'memphis_self_modify': 'codemod',
    'memphis_soul_write': 'action',
    'memphis_cron': 'action',
    'memphis_chain_query': 'introspection',
    'memphis_recall': 'introspection',
    'memphis_soul_read': 'introspection',
    'memphis_health': 'introspection',
    'memphis_case_query': 'introspection',
    'memphis_grep': 'search',
    'memphis_glob': 'search',
    'memphis_code_read': 'search',
}

# ---------- Load ----------
tool_turns = []
for line in (RAW / 'tool-calls.jsonl').read_text().splitlines():
    if line.strip():
        tool_turns.append(json.loads(line))

trajectories = []
for line in (RAW / 'trajectories.jsonl').read_text().splitlines():
    if line.strip():
        trajectories.append(json.loads(line))

print(f'Loaded {len(tool_turns)} tool turns, {len(trajectories)} session trajectories')

# ---------- Dedup (loose: user+tools+args) ----------
seen_sig = set()
deduped = []
for t in tool_turns:
    args_sig = json.dumps(
        sorted([(tc['name'], json.dumps(tc.get('arguments', {}), sort_keys=True, ensure_ascii=False))
                for tc in t.get('tool_calls', [])]),
        ensure_ascii=False
    )
    sig = hashlib.sha256(((t.get('user_input') or '').strip() + '|' + args_sig).encode()).hexdigest()
    if sig in seen_sig: continue
    seen_sig.add(sig)
    deduped.append(t)
print(f'After dedup: {len(deduped)} (removed {len(tool_turns) - len(deduped)} duplicates)')

# ---------- Tag (quality, length, category, dominant tool) ----------
for t in deduped:
    thinking = (t.get('assistant_thinking') or '').strip()
    t['_thinking_len'] = len(thinking)

    tcs = t.get('tool_calls', [])
    t['_dominant_tool'] = tcs[0]['name'] if tcs else None
    t['_category'] = TOOL_CATEGORY.get(t['_dominant_tool'], 'unknown')

    # Check tool results for failures
    results = t.get('tool_results', [])
    has_failure = False
    for r in results:
        c = r.get('content') or ''
        name = r.get('name') or ''
        if 'memphis_exec' in name and '"exitCode"' in c and '"exitCode":0' not in c:
            has_failure = True
            break
        # Error envelope check
        if '"error"' in c[:300].lower() and 'tool_error' in c.lower()[:300]:
            has_failure = True
            break

    if has_failure:
        t['_quality'] = 'failed'
    elif t['_thinking_len'] >= 20:
        t['_quality'] = 'full'
    else:
        t['_quality'] = 'thin'

q_counts = Counter(t['_quality'] for t in deduped)
print(f'Quality tags: {dict(q_counts)}')
len_dist = Counter('0' if t['_thinking_len'] == 0
                   else '1-10' if t['_thinking_len'] < 11
                   else '11-50' if t['_thinking_len'] < 51
                   else '51-200' if t['_thinking_len'] < 201
                   else '200+'
                   for t in deduped)
print(f'Thinking-length distribution: {dict(len_dist)}')

# ---------- Balance per-tool (cap memphis_exec at 40%) ----------
by_tool = defaultdict(list)
for t in deduped:
    if t['_dominant_tool']:
        by_tool[t['_dominant_tool']].append(t)

print('\nPer-dominant-tool counts (post-dedup):')
for tool, lst in sorted(by_tool.items(), key=lambda x: -len(x[1])):
    print(f'  {tool}: {len(lst)}')

exec_turns = by_tool.get('memphis_exec', [])
non_exec_count = sum(len(v) for k, v in by_tool.items() if k != 'memphis_exec')
exec_cap = max(int(non_exec_count * 40 / 60), 8) if non_exec_count > 0 else len(exec_turns)
if len(exec_turns) > exec_cap:
    full_exec = [t for t in exec_turns if t['_quality'] == 'full']
    thin_exec = [t for t in exec_turns if t['_quality'] == 'thin']
    failed_exec = [t for t in exec_turns if t['_quality'] == 'failed']
    random.shuffle(full_exec); random.shuffle(thin_exec); random.shuffle(failed_exec)
    # Prefer full > failed > thin (failed teaches error-handling, thin is filler)
    kept = (full_exec + failed_exec + thin_exec)[:exec_cap]
    by_tool['memphis_exec'] = kept
    print(f'\nDownsampled memphis_exec: {len(exec_turns)} → {len(kept)} (cap 40%)')

balanced = []
for lst in by_tool.values():
    balanced.extend(lst)
print(f'After balance: {len(balanced)}')

# ---------- Negatives (no-tool assistant turns from trajectories) ----------
negatives = []
for sess in trajectories:
    msgs = sess['messages']
    for i, m in enumerate(msgs):
        if m['role'] != 'assistant': continue
        if m.get('tool_calls'): continue
        thinking = (m.get('content') or '').strip()
        if len(thinking) < 20: continue  # negatives need substance
        user = next((msgs[j] for j in range(i-1, -1, -1) if msgs[j]['role'] == 'user'), None)
        if not user: continue
        negatives.append({
            'session_id': sess['session_id'],
            'sequence': m['sequence'],
            'created_at': m['created_at'],
            'model': m['model'],
            'user_input': user['content'],
            'assistant_reply': m['content'],
            'tool_choice': 'none',
            '_reply_len': len(thinking),
        })

seen_neg = set()
neg_dedup = []
for n in negatives:
    sig = hashlib.sha256(((n['user_input'] or '')[:200] + '|' + (n['assistant_reply'] or '')[:200]).encode()).hexdigest()
    if sig in seen_neg: continue
    seen_neg.add(sig)
    neg_dedup.append(n)
print(f'\nNegatives: {len(negatives)} → {len(neg_dedup)} after dedup')

# ---------- Train/eval split: random 80/20 per-turn (sessions cross splits OK) ----------
# Per-session split was degenerate when one session had 0 tool turns and won the
# eval lottery. Per-turn random gives balanced eval coverage of tools+negatives.
def split_8020(records):
    r = list(records)
    random.shuffle(r)
    cut = max(1, len(r) // 5)
    return r[cut:], r[:cut]  # train, eval

bal_train, bal_eval = split_8020(balanced)
neg_train, neg_eval = split_8020(neg_dedup)

eval_sessions = sorted(set(t['session_id'] for t in bal_eval) | set(n['session_id'] for n in neg_eval))
print(f'\nSplit: balanced {len(bal_train)}/{len(bal_eval)} train/eval, negatives {len(neg_train)}/{len(neg_eval)}')
print(f'  eval includes sessions: {eval_sessions}')

# ---------- Write outputs ----------
def write_jsonl(path, items):
    with path.open('w') as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + '\n')

write_jsonl(OUT / 'trajectory-train.jsonl', bal_train)
write_jsonl(OUT / 'trajectory-eval.jsonl', bal_eval)

# Tool-selection format (input → tool label, for classification head)
def to_tool_selection(items, with_tool=True):
    out = []
    for t in items:
        if with_tool:
            out.append({
                'session_id': t['session_id'],
                'sequence': t['sequence'],
                'user_input': t['user_input'],
                'tool_choice': t['_dominant_tool'],
                'tool_args': t['tool_calls'][0].get('arguments') if t.get('tool_calls') else None,
                'category': t['_category'],
                '_quality': t['_quality'],
            })
        else:
            out.append({
                'session_id': t['session_id'],
                'sequence': t['sequence'],
                'user_input': t['user_input'],
                'tool_choice': 'none',
                'tool_args': None,
                'category': 'no_tool',
                '_reply_len': t.get('_reply_len'),
            })
    return out

sel_train = to_tool_selection(bal_train, True) + to_tool_selection(neg_train, False)
sel_eval = to_tool_selection(bal_eval, True) + to_tool_selection(neg_eval, False)
random.shuffle(sel_train)
random.shuffle(sel_eval)
write_jsonl(OUT / 'tool-selection-train.jsonl', sel_train)
write_jsonl(OUT / 'tool-selection-eval.jsonl', sel_eval)

write_jsonl(OUT / 'negatives.jsonl', neg_dedup)

# Stats
stats = {
    'generated_at': '2026-05-11',
    'source': 'operator_chat_messages window 2026-05-10 → 2026-05-11',
    'raw_input': {
        'tool_turns': len(tool_turns),
        'session_trajectories': len(trajectories),
    },
    'curation': {
        'after_dedup': len(deduped),
        'after_balance': len(balanced),
        'quality_distribution': dict(q_counts),
        'thinking_length_distribution': dict(len_dist),
        'exec_cap_40pct_applied': len(exec_turns) > exec_cap if non_exec_count > 0 and exec_turns else False,
    },
    'final_curated': {
        'trajectory_train': len(bal_train),
        'trajectory_eval': len(bal_eval),
        'tool_selection_train': len(sel_train),
        'tool_selection_eval': len(sel_eval),
        'negatives_total': len(neg_dedup),
        'negative_train': len(neg_train),
        'negative_eval': len(neg_eval),
    },
    'tool_distribution_after_balance': {k: len(v) for k, v in by_tool.items()},
    'category_distribution_after_balance': dict(Counter(t['_category'] for t in balanced)),
    'sessions_train': sorted(set(t['session_id'] for t in bal_train) | set(n['session_id'] for n in neg_train)),
    'sessions_eval': eval_sessions,
    'split_strategy': '80/20 random per-turn (sessions may cross splits — acceptable for trajectory/tool-selection training)',
    'usage_notes': {
        'filter_for_quality': "WHERE _quality == 'full'  (only turns with substantive reasoning)",
        'filter_for_error_handling': "WHERE _quality == 'failed'  (turns where bot needs to recover from tool error)",
        'filter_for_short_thinking': "WHERE _thinking_len < 20  (terse dispatch — common in MiniMax-M2.7 era)",
    },
}
(OUT / 'stats.json').write_text(json.dumps(stats, indent=2, ensure_ascii=False))

print('\n=== FINAL OUTPUT ===')
for p in sorted(OUT.glob('*')):
    print(f'  {p.name:35s} {p.stat().st_size:>10d} bytes')
