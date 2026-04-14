# Cognitive Models — Implementation Status

**Date:** 2026-03-28
**Scope:** Cognitive models A–E from `docs/COGNITIVE-MODELS.md`

---

## Summary

All five cognitive models are implemented in the codebase. There are no design-only or stub implementations. The runtime now uses a bounded automatic cognitive pass around each turn, while heavier cognitive lanes remain scoped and optional.

| Model | Name | Status | Source File | Lines |
|-------|------|--------|-------------|-------|
| **A** | Conscious Capture | IMPLEMENTED | `src/cognitive/model-a.ts` | 213 |
| **B** | Inferred Decisions | IMPLEMENTED | `src/cognitive/model-b.ts` | 513 |
| **C** | Predictive Patterns | IMPLEMENTED | `src/cognitive/model-c.ts` | 611 |
| **D** | Collective Coordination | IMPLEMENTED | `src/cognitive/model-d.ts` | 709 |
| **E** | Meta-Cognitive Reflection | IMPLEMENTED | `src/cognitive/model-e.ts` | 559 |

---

## Model A: Conscious Capture

**File:** `src/cognitive/model-a.ts`

Captures decisions and milestones explicitly. Writes to the journal/decisions chains.

**Key methods:**
- `capture()` — persists a decision or milestone to the chain
- `autoCapture()` — pattern-matching automatic capture
- `inferCapture()` — detects `decision:`, `milestone:`, `released` signals in text

**Runtime integration:** automatic post-response capture on explicit signals via the chat loop cognitive pass.

---

## Model B: Inferred Decisions

**File:** `src/cognitive/model-b.ts`

Infers decisions from indirect signals. Canonical product truth treats chain-backed activity history as the primary signal; git/file helpers remain optional adjunct paths.

**Key methods:**
- `inferFromChainHistory()` — canonical Model B path over chain-backed activity history
- `inferFromActivity()` — detects tag distribution shifts over time
- `inferFromGit()` — optional helper that parses `git log` via `spawnSync()`
- `inferFromFileChanges()` — optional helper for recurring file patterns (`package.json`, `Dockerfile`, etc.)
- `inferAndPersist()` — merges enabled inference strategies and writes to decision chain

**Confidence scoring:** Uses recency decay — recent signals weight more heavily.

**Runtime boundary:** Model B now runs inside the bounded primary chat-loop cognitive pass using chain-backed activity history. Git/file helpers remain implemented, but disabled by default and treated as secondary debug/review signals.

---

## Model C: Predictive Patterns

**File:** `src/cognitive/model-c.ts`

Learns patterns from local decision-chain history and generates bounded-confidence predictions.

**Key methods:**
- `learn()` — extracts patterns from decision history
- `predict()` — generates predictions with confidence bounds
- `groupBySimilarContext()` — Jaccard-like clustering of decisions
- `calculateContextSimilarity()` — similarity scoring
- `persistPattern()` — writes to `patterns` chain
- `recordAccuracy()` — feedback loop for prediction accuracy

**Storage:** Model C persists derived pattern state to the `patterns` chain. `repair runtime` may clear stale legacy `patterns.json` residue, but runtime prediction no longer depends on a filesystem cache.

**Runtime integration:** Model C contributes bounded predictions in the automatic pre-response pass and continues to learn from local chain history after response delivery.

---

## Model D: Collective Coordination

**File:** `src/cognitive/model-d.ts`

Voting and consensus across local and remote agents. Multi-agent coordination protocol.

**Key methods:**
- `propose()` — creates proposals with status lifecycle
- `vote()` — weighted voting with deadline enforcement
- `shouldCloseVoting()` — consensus detection
- `closeVoting()` — weighted score calculation
- `execute()` — decision execution tracking
- `signVote()` / `verifyVote()` — Ed25519 cryptographic signatures for vote integrity
- `saveKey()` — fail closed until vault-backed key persistence exists
- `simulateNetworkVoting()` — test multi-agent voting with a simulated network
- `getLastBroadcastResults()` — retrieve results from the most recent network broadcast

**Network protocol:**
- `broadcastProposal()` — HTTP POST to remote agents
- `AgentCoordinator` class — manages peer registry, HTTP communication, and network broadcast
- `BroadcastVote` / `BroadcastResult` types — wire format for multi-agent voting

**Cryptographic voting:** Votes are signed with an Ed25519 private key (randomly generated on instantiation, or provided via constructor). The `saveKey()` method now fails closed instead of persisting private key material to append-only chain storage; durable recovery requires future vault-backed key management.

**Related types:** `src/cognitive/model-d-types.ts` — `AgentRegistry`, `RelationshipGraph`, `CollaborativeFilter`, `TrustMetrics`

**CLI integration:** `memphis cognitive categorize` (via `src/infra/cli/commands/cognitive.ts`)

---

## Model E: Meta-Cognitive Reflection

**File:** `src/cognitive/model-e.ts`

Reflects on memory quality, detects contradictions, identifies blind spots.

**Key methods:**
- `daily()` / `weekly()` / `deep()` — three reflection modes (1-day, 7-day, 30-day windows)
- `calculateStats()` — entries, tags, time distribution
- `extractInsights()` — pattern, trend, anomaly, opportunity detection
- `detectContradictions()` — logical and temporal conflict detection
- `detectBlindSpots()` — missing topic/tag analysis
- `generateRecommendations()` — actionable suggestions
- `persistReflection()` — writes to `reflections` chain

**Extensions:**
- `src/cognitive/insight-generator.ts` — `InsightGenerator`
- `src/cognitive/knowledge-synthesizer.ts` — `KnowledgeSynthesizer`
- `src/cognitive/connection-discovery.ts` — `ConnectionDiscovery`, `ProactiveSuggestionEngine`

**CLI integration:** `memphis cognitive insights`, `memphis cognitive connections`, `memphis cognitive reflect`

---

## Rust TUI Decision Screen

The Rust TUI and TUI host expose decision-oriented surfaces backed by the canonical `decisions` chain and the chain-first decision CLI path.

Related:
- `crates/memphis-tui/`
- `crates/memphis-operator/`

Each model writes to specific chain types:

| Model | Chain | Block Type |
|-------|-------|------------|
| A | `journal` / `decisions` | `conscious_capture` |
| B | `decisions` | `inferred_decision` |
| C | `patterns` | `pattern` |
| D | `decisions` | `proposal` / `vote` |
| E | `reflections` | `reflection` |

---

## CLI Commands

All cognitive models are accessible via `memphis cognitive`:

```bash
memphis cognitive learn          # Model C: learn patterns
memphis cognitive insights       # Model E: generate insights
memphis cognitive connections   # Model E: discover connections
memphis cognitive suggest       # Proactive suggestions
memphis cognitive categorize    # Model D: categorization
memphis cognitive reflect       # Model E: reflection
```

---

## Tests

| Model | Test File |
|-------|-----------|
| A, B, C, E | `tests/cognitive/cognitive-integration.test.ts` |
| A, B, C, E | `tests/integration/cognitive-chain-integration.test.ts` |

Model D tests are in `tests/integration/cognitive-chain-integration.test.ts:75-88`.

---

## Reference

- `docs/COGNITIVE-MODELS.md` — Model specifications and design intent
- `src/cognitive/` — All cognitive model source files
- `src/infra/cli/commands/cognitive.ts` — CLI command handlers
