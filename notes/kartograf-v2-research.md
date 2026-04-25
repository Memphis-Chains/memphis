# Kartograf v2 — research brief: what a 150M coding encoder needs

> Written 2026-04-24 as part of N32 corpus v2 augmentation. Captures the rationale for pulling in Rust Book + TS Handbook + memphis-v5.pl on top of the v1 code-and-chain corpus, and flags what this architecture CAN and CANNOT do for agent-side coding assistance.

## What Kartograf is (role re-clarification)

Kartograf is an **encoder**. It produces a 256-dim L2-normalized embedding and a 12-way zone distribution per input. It does NOT generate code. The naming shorthand "niech kartograf uczy agenta kodować" is load-bearing and worth unpacking:

- Kartograf embeds the agent's query (e.g., "add a field to the Rust case entry struct") and ranks candidate documents by cosine similarity.
- The runtime agent (full LLM, Ollama-hosted) reads the retrieved documents and writes code informed by them.
- So "Kartograf teaches the agent to code" is accurate only in this sense: Kartograf is the *retrieval oracle* that surfaces idiomatic reference material + in-repo examples fast, locally, and without a network call.

Implication for corpus design: we need the retrieval target content in the training distribution. If the Rust Book chapter on traits isn't embedded alongside Memphis Rust files using traits, the nearest-neighbor lookup won't find it.

## What a 150M-param encoder actually learns

Encoders at this scale (ModernBERT-base 150M, BGE-small 33M, E5-small 33M, SBERT-MiniLM-L6 22M) primarily learn:

1. **Lexical + substring-token similarity** (BPE vocab overlap, stemming, case-folding).
2. **Syntactic proximity** (co-occurrence windows, attention between symbols in the same context).
3. **Weak semantic clustering** (pairs that appear together during training end up close in embedding space).

They do NOT learn:
- World knowledge or reasoning (too few parameters, no CoT objective).
- Long-range cross-document inference.
- Code correctness or type-checking.

This puts the corpus question in focus: the encoder will cluster what you show it as co-occurring. If `Box<dyn Trait>` in Memphis Rust code is paired (via pair miner or in-batch proximity) with the Rust Book chapter on trait objects, queries mentioning `dyn Trait` will surface both, and the agent gets both reference + example. That's the whole play.

## What the agent needs, by concrete task type

| Task | Reference material needed | Already in corpus? |
|---|---|---|
| Add a struct field + impl Serde | Rust Book: §5 structs, §10.2 traits, §19.5 advanced traits | v2 ✓ |
| Fix a TS generic constraint bug | TS Handbook: Generics, Utility Types, Narrowing | v2 ✓ |
| Write a new memphis-core block type | Memphis src/core/, existing chain-catalog.ts | v1 ✓ |
| Follow operator conventions (commit format, PR flow) | CLAUDE.md + feedback memories | v1 ✓ (CLAUDE.md), NO (memories are operator-local) |
| Understand Memphis chain semantics (append-only, hashes, consent) | docs/dev/CHAIN-*.md + src/memory/chain.ts | v1 ✓ |
| Deploy / install / troubleshoot Memphis | memphis-v5.pl/docs/instalacja/* | v2 ✓ |

The jump from v1 to v2 specifically targets the first two rows — language idiom coverage the repo alone couldn't provide.

## What the corpus CANNOT fix at 150M params

- **"100% chance of success" is not achievable by model alone.** The agent writing code can still produce syntactic errors, type mismatches, or logic bugs. Kartograf reduces the probability of *getting lost* (wrong file, wrong pattern, wrong convention) but does not verify generated code.
- **Safety / security gates stay path-based.** `src/mcp/tools/self-modify.ts` hard-denies paths; Kartograf's advisory output is NOT a substitute (spec §Safety oracle: "advisory only, hard blocks stay path-based").
- **The model will NOT cite sources at inference.** Retrieval returns the nearest chunk; if two chunks are equally close (Rust Book vs a Memphis example), the runtime must show both to the agent and let it weigh them. That's a UI concern, not a model concern.

## v2 additions — what, why, license

Per `corpus-v2-summary.json.augmentation.sources`:

| Source | License | Samples | Purpose |
|---|---|---|---|
| `rust-lang/book` | Apache-2.0 | 905 | Rust language idioms, stdlib patterns, trait/generic/ownership reference |
| `microsoft/TypeScript-Website` (handbook) | CC-BY-4.0 | 1440 | TS type system, generics, narrowing, module system reference |
| `memphis-v5.pl/docs` | operator:public | 36 | Operator-facing architecture + install + concept docs, Polish-language coverage |

Zone distribution after augmentation:
- `patterns`: 2358 (62%) — up from 13 (1%) in v1. These are the reference chunks.
- `system`: 1313 (34%) — down from 88% in v1. Still the next-largest.
- `collective` / `reflections` / `cases` / `journal` / `insights` / `decisions`: small tail (operator chain history).

**The rebalancing is the point.** v1 had 88% `system` which trivializes the zone classifier (always predicting `system` hits 88%). v2's balance lets the classifier actually learn to separate reference material (`patterns`) from operator infrastructure (`system`) from decisions. Retrieval quality on code queries should improve as a side-effect since the embedding space is no longer dominated by audit-log noise.

## Attribution (for MODELCARD.md in the v1.7.0 release)

- "The Rust Programming Language" © Steve Klabnik and Carol Nichols, the Rust Project contributors. Apache-2.0.
- TypeScript Handbook © Microsoft. CC-BY-4.0 — attribution here suffices.
- memphis-v5.pl documentation © Memphis-Chains (operator). Public-facing site content.

## Open risks (explicit non-claims)

- Rust Book and TS Handbook cover *general* language patterns. Memphis-specific idioms (our chain abstractions, NAPI bridge patterns, ISKRA/PULSE conventions) are in v1 only. Query that mixes both ("add a Memphis-style chain in Rust") should retrieve cross-pollinated neighbors if pair mining + in-batch negatives work as expected — **we'll know from Phase 3 eval, not before.**
- Polish-language memphis-v5.pl chunks introduce a monolingual signal into an otherwise English corpus. ModernBERT's multilingual tokenizer handles Polish tokens but at 36 samples, the signal is thin. Not a blocker; worth flagging if eval reveals unexpected PL/EN blending in retrieval.
- memvid as a runtime index is a separate concern from training. Q2 scope is train-and-ship; Q3+ can evaluate memvid as tier-0 cold-start retrieval.
