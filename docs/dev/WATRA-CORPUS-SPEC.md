# WatraLLM Training Corpus Specification

**Date:** 2026-04-22
**Status:** Approved
**Target:** ~3000 query/pointer pairs across 5 categories

## Purpose

WatraLLM is a pointer/router — it maps natural-language queries to `{ chain, selector, reasoning, confidence }`. The training corpus teaches it which chain holds which information, and how to select the right entry within a chain.

## Format

JSONL with provenance metadata:

```jsonl
{"query": "what did we decide about the embedding provider?", "answer": {"chain": "decisions", "selector": "content:embedding", "reasoning": "decisions about technical choices go to the decisions chain", "confidence": 0.92}, "category": "memphis-structure", "source_file": "src/gateway/tool-registry.ts", "confidence": 0.95, "negative_chain": "journal"}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | yes | Natural language query |
| answer | object | yes | Pointer output: chain, selector, reasoning, confidence |
| category | string | yes | One of the 5 categories below |
| source_file | string | yes | File the pair was derived from |
| confidence | number | yes | 0.0–1.0, how certain the pair is correct |
| negative_chain | string | no | Hard negative — chain that seems relevant but is wrong |

### Hard Negatives (from AgentGate)

AgentGate (arXiv:2604.06696) demonstrates that candidate-aware supervision with hard negatives improves routing accuracy by 8-12% over positive-only training. Each pair optionally includes a `negative_chain` — the chain a naive model would incorrectly select.

Examples:
- "what did we decide about X?" → decisions chain. Hard negative: journal (also mentions decisions casually).
- "when did agent last run tool Y?" → cases chain (instrumental). Hard negative: system-events (also logs tool usage).
- "what's the operator's preference for Z?" → soul chain (user section). Hard negative: journal (operator mentions preferences).

## Categories

### 1. Memphis Structure (~800 pairs)

Auto-extractable from:
- `src/gateway/tool-registry.ts` — 37 tools with names, tiers, capabilities, descriptions
- Chain catalog (9 live chains: journal, decisions, reflections, insights, system-events, cases, pulse, trajectory, soul)
- Cognitive modes A–E with output shapes
- Config schema (`src/infra/config/schema.ts`)

Example pairs:
```
Q: "which tool writes to the journal?"
A: { chain: "tool-registry", selector: "name:memphis_journal", reasoning: "memphis_journal is the tool that saves entries to the journal chain" }

Q: "how many chains does memphis have?"
A: { chain: "system-events", selector: "tag:chain-catalog", reasoning: "chain metadata is in system-events; 9 live chains" }
```

### 2. Safety / Drills (~600 pairs)

Sources:
- `src/security/*` — vault boundary, content scan, runtime security events, audit
- `src/infra/auth/*` — operator gate, tier-2/3 passphrase files
- Test patterns from `tests/unit/security/*`
- Runbooks and incident patterns

Example pairs:
```
Q: "is it safe to run memphis_exec with user-provided input?"
A: { chain: "tool-registry", selector: "name:memphis_exec", reasoning: "memphis_exec routes through exec policy; only allowlisted commands pass" }

Q: "what happens if someone tries to read .env through memphis_code_read?"
A: { chain: "security", selector: "fs-permission", reasoning: "always-blocked paths (.env, vault-*) are denied even at tier 3" }
```

### 3. Code-Modification Patterns (~600 pairs)

Sources:
- `git log --oneline -200` — recent commit patterns
- PR descriptions and patterns
- Invariant rules from CLAUDE.md and docs/dev/

Example pairs:
```
Q: "how do I add a new CLI command?"
A: { chain: "docs", selector: "codebase-atlas-v2:how-to-add-cli", reasoning: "the codebase atlas v2 has step-by-step patterns for adding CLI commands" }

Q: "what's the pattern for adding a new MCP tool?"
A: { chain: "docs", selector: "codebase-atlas-v2:how-to-add-tool", reasoning: "tool addition follows: handler in src/mcp/tools/ → register in server.ts → add to tool-registry.ts" }
```

### 4. Tools API (~600 pairs)

One query/answer block per tool (37 tools × ~16 pairs each):
- "what does tool X do?"
- "what are tool X's input parameters?"
- "what tier is tool X?"
- "can tool X write to files?"

Sources:
- `src/gateway/tool-registry.ts` (authoritative metadata)
- `src/mcp/tools/*.ts` (handler implementations)
- `src/mcp/server.ts` (MCP registration)

### 5. Skills Creation (~400 pairs)

Sources:
- Skills manifest format
- CLI workflow for `memphis skills list|show|install|create|validate|import`
- Example skills in `apps/skills/`

## Generation Pipeline

```
Step 1: Auto-extract (categories 1, 4)
  ├─ Parse tool-registry.ts → generate tool Q/A pairs
  ├─ Parse chain catalog → generate chain Q/A pairs
  └─ Parse cognitive modes → generate mode Q/A pairs

Step 2: Semi-auto (categories 2, 3, 5)
  ├─ Extract patterns from security/* → generate safety pairs
  ├─ Extract patterns from git log → generate code-mod pairs
  └─ Extract patterns from skills/ → generate skills pairs

Step 3: Manual review
  ├─ Verify confidence scores
  ├─ Add hard negatives
  └─ Deduplicate similar pairs

Step 4: Split
  ├─ Training set: 2900 pairs (random 96.7%)
  └─ Eval set: 100 pairs (stratified 20 per category)
```

### Input material

`memphis_code.jsonl` (existing code dump) is input material, NOT the corpus itself. It needs transformation into query/pointer pairs. Raw code dumps teach the model to recite code, not to route queries.

## Quality Criteria

- Each pair must have a verifiable source file.
- Confidence ≥ 0.7 for inclusion in training set.
- Hard negatives present for ≥ 40% of pairs.
- No duplicate queries (fuzzy dedup with edit distance < 0.3).
- Eval set pairs must NOT appear in training set (strict holdout).

## Output Location

```
tools/training/corpus/
  ├─ train.jsonl          (training set)
  ├─ eval.jsonl           (held-out eval set)
  ├─ metadata.json        (generation stats, source coverage)
  └─ generate-corpus.py   (generation script)
```
