# Trajectory data — Anthropic-key window 2026-05-10 → 2026-05-11

**Generated:** 2026-05-11 morning by Claude Code session.
**Source:** `~/memphis/data/memphis.db` → table `operator_chat_messages` (3261 rows total, 393 in window).
**Window:** `created_at >= '2026-05-10' AND created_at < '2026-05-12'`.

---

## Headline finding

**Bot na Telegramie nigdy nie był na Anthropic.** Operator's recall "ostatnie rozmowy gdy bot na anthropic" była luźna. Faktycznie:

- **3 wiadomości Claude** total — wszystkie z CLI (`cli.chat`), session `primary::operator:local`, krótkie ping-pong tests:
  - 2026-05-10T19:55Z `pong 🟢 — via anthropic/claude-sonnet-4-6`
  - 2026-05-10T19:56Z "Cześć Marcin — drugi raz na CLI dzisiaj..." (claude-sonnet-4-6)
  - 2026-05-10T20:22Z "Pong! 🏓 CLI działa, Opus 4.6 odpowiada. Co robimy?" (claude-opus-4-6)
- **Reszta okna (2026-05-10/11)** — **MiniMax-M2.7 jako jedyny faktyczny LLM**. `SOUL_PROVIDER=minimax` cały dzień.

Powód: operator dodał Anthropic key i konfigurację 2026-05-10, ale `.env` SOUL_PROVIDER pozostał `minimax` → Telegram + TUI bot route'owały na MiniMax. Klucz Anthropic użyty tylko gdy operator explicit specified `--provider anthropic` w CLI.

**Konsekwencja dla treningu Kartografa:** nie ma "Anthropic-era trajectory data" w ścisłym sensie. ALE okno czasowe (2026-05-10/11) **MA bardzo bogatą trajectory data MiniMax** — 105 tool-call turns z reasoning + dispatch. Jeśli cel to wytrenowanie Kartografa **niezależnego od LLM provider**, to data jest gold.

---

## Layout

```
anthropic-window-2026-05-10/
├── README.md                          (this file — overview + findings)
├── curate.py                          (curation pipeline, stdlib only, seed=42)
├── raw/                               (original SQLite export, untouched)
│   ├── trajectories.jsonl             (4 sessions, full message arrays)
│   ├── tool-calls.jsonl               (105 tool-dispatching turns)
│   └── kartograf-candidates-v4.jsonl  (137 zone-labeled samples for v1 corpus schema)
└── curated/                           (post-pipeline, training-ready)
    ├── README.md                      (recipes + schemas + filter examples)
    ├── stats.json                     (pipeline metrics + filter guide)
    ├── trajectory-{train,eval}.jsonl  (21/5 balanced turns, _quality tagged)
    ├── tool-selection-{train,eval}.jsonl  (63/15 classifier inputs: tool or 'none')
    └── negatives.jsonl                (52 no-tool replies for binary head)
```

**Backup:** `~/Backups/training-data-anthropic-window-20260511-111652/` (1.7M, full set).

## Raw files (3)

### 1. `trajectories.jsonl` (655 KB) — full conversations
4 sesje, każda jako **1 JSON record** z `messages` array:
```jsonl
{
  "session_id": "tui-6a010c82",
  "msg_count": 210,
  "tool_call_count": 117,
  "models_used": ["MiniMax-M2.7", "local-fallback-v0"],
  "created_first": "2026-05-10T22:54:35Z",
  "created_last": "2026-05-10T23:23:59Z",
  "messages": [
    {"sequence": 1, "role": "user", "content": "...", ...},
    {"sequence": 2, "role": "assistant", "content": "thinking...", "tool_calls": [...], ...},
    {"sequence": 3, "role": "tool", "tool_name": "memphis_exec", "content": "...", ...},
    ...
  ]
}
```

Sesje w window:
- `tui-6a010c82` — 210 msgs, 117 tool calls (2026-05-10 22:54→23:24)
- `tui-6a010202` — 115 msgs, 63 tool calls (2026-05-10 22:09→22:50)
- `primary::telegram:1316033647` — 58 msgs, 0 tools (Telegram, raw text)
- `primary::operator:local` — 10 msgs, 0 tools (CLI ping tests + 3 Claude calls)

### 2. `tool-calls.jsonl` (911 KB) — training-ready trajectory turns
**105 trajectory records**, każdy = jeden tool-dispatching turn z pełnym kontekstem:
```jsonl
{
  "session_id": "tui-6a010202",
  "sequence": 6,
  "created_at": "2026-05-10T22:20:15Z",
  "model": "MiniMax-M2.7",
  "user_input": "...co operator zapytał...",
  "assistant_thinking": "...co bot napisał ZANIM dispatched tool (chain-of-thought)...",
  "tool_calls": [
    {"id": "...", "name": "memphis_exec", "arguments": {"command": "..."}},
    {"id": "...", "name": "memphis_glob", "arguments": {"pattern": "..."}}
  ],
  "tool_results": [
    {"name": "memphis_exec", "content": "...stdout..."},
    {"name": "memphis_glob", "content": "...matches..."}
  ]
}
```

**Ta to TWOJE "jak myślał + jakich narzędzi używał"** — najbardziej training-ready format.

### 3. `kartograf-candidates-v4.jsonl` (112 KB) — zone-labeled samples
137 sha-deduped samples w schemacie zgodnym z `~/.memphis/kartograf/corpus/v1/train.jsonl`:
```jsonl
{
  "sha256": "...",
  "source_path": "sqlite:operator_chat_messages/tui-.../seq123",
  "zone": "journal",
  "content": "...",
  "license": "operator:local-only",
  "mutability": 0.4,
  "ambiguous": false,
  "_chat_meta": {"role": "assistant", "model": "MiniMax-M2.7", "tool_name": "...", ...}
}
```

Wszystko jako zone=`journal` (chat msgs ≈ raw events). Mogą zostać dołączone do kartograf v4 corpus jako augmentation.

---

## Tool usage breakdown (105 turns, 179 total calls)

| Tool | Calls | % | Notes |
|------|-------|---|-------|
| `memphis_exec` | 151 | 84% | Bash dominuje — operator's questions → exec inquiries |
| `memphis_chain_query` | 11 | 6% | Semantic chain search |
| `memphis_self_modify` | 4 | 2% | TS code edit (snapshot+branch+test gate workflow) |
| `memphis_recall` | 4 | 2% | Semantic memory recall |
| `memphis_cron` | 3 | 2% | Scheduler ops |
| 7 inne | 7 | 4% | grep, glob, soul_read/write, health, code_read, case_query |

**Observation:** Bot mocno polega na `memphis_exec` (bash) zamiast specialized tools (grep/glob/code_read). To może być sygnał:
- (a) Bot nie wie o specialized tools / ich nie wybiera optimally
- (b) Operator-question patterns wymuszają bash (np. "co tam w logach")
- (c) MiniMax's tool routing heuristic biased toward exec

Jeśli Kartograf ma uczyć **tool selection** (jako classifier head), te dane pokazują dystrybucję, ale są **mocno biased na exec**. Augment z innych sesji (jeśli kiedyś bot prowadził analizy gdzie operator pytał o kod/grep) byłby zdrowy.

---

## Path forward dla Kartografa

**Kartograf v1/v2/v3 jest encoder** (ModernBERT-base 150M params) trained on zone-labeled corpus dla retrieval. To znaczy:
- Te dane (137 samples z zone=journal) mogą zostać **dołączone do v4 corpus** jako augmentation
- ALE Kartograf zone classifier już ma `journal` w v1 (z chain blocks). Dodanie chat msgs nie zmienia zone vocabulary, ale **rozszerza idiomatic surface** dla zone=journal

**Jeśli chcesz uczyć tool-selection head** (Kartograf multi-task spec § frozen wspomina multi-task heads), trzeba osobny dataset:
- Input: user message + context
- Label: tool_name chosen (lub `none`)
- Format: 105 tool-call turns + N negatywne (turns bez tool) → balanced binary/multi-class set

**Jeśli chcesz uczyć Watra (LLM)** w trajectory SFT:
- `tool-calls.jsonl` jest training-ready (Anthropic-style trajectory format)
- Plus need cleaning: filter out failed turns, dedup repeated bash exec patterns

---

## Roadmap step (do operator decision)

1. **Hold** — dane są przygotowane, decyzja co dalej oddana operatorowi.
2. **Dołącz do v4 corpus** — `cp kartograf-candidates-v4.jsonl ~/.memphis/kartograf/corpus/v4/incoming/` + re-build corpus (current v3 ma takie samples już; check overlap).
3. **Tool-selection head dataset** — wymaga negatywne samples (turns bez tool) + label cleanup; ~30 min skrypt.
4. **Watra trajectory SFT** — `tool-calls.jsonl` gotowy do load, ale Watra training infra wymaga osobnego ENV (Qwen2.5-0.5B + QLoRA + BF16 per memory `watrallm_training_empirical_2026_04_22.md`).

---

## Cytowane konkretnie

- DB: `~/memphis/data/memphis.db` (36MB, May 11 01:23 mtime)
- Table: `operator_chat_messages` (3261 rows; window: 393)
- Source query: `SELECT ... FROM operator_chat_messages WHERE created_at >= '2026-05-10' AND created_at < '2026-05-12' ORDER BY session_id, sequence`
- Existing corpus: `~/.memphis/kartograf/corpus/v1/train.jsonl` (8.3MB, last update May 6)
- Kartograf trainer: `tools/training/kartograf_train/data.py:24-29` (zone taxonomy)
- Kartograf spec frozen: memory `kartograf_spec_frozen.md` (ModernBERT-base, multi-task head, 4GB VRAM)
- WatraLLM empirical: memory `watrallm_training_empirical_2026_04_22.md` (Qwen2.5-0.5B + QLoRA + BF16)

---

**Last updated:** 2026-05-11 morning.
**Next refresh:** kiedy operator zdecyduje którą ścieżką iść (corpus aug vs tool-head vs Watra SFT), albo gdy będzie nowy window z bot conversations.
