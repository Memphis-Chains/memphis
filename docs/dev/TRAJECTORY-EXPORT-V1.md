# Trajectory Export v1 — Design Proposal

Status: **proposal** (draft for discussion before implementation)
Scope: design decisions + schema v1 + exporter contract.
Does not ship code. Implementation follows in separate PR(s).

## Why

Memphis already produces rich per-turn artifacts across 9 chains (`journal`, `decisions`, `reflections`, `insights`, `patterns`, `cases`, `collective`, `soul`, `system`). Every block carries an Ed25519 signature and hash-chain link — provenance is **already** stronger than any public agent-trajectory dataset.

But the data is scattered. There is no stable contract to serialize a session's trajectory, and no way to compare two trajectories against each other. Without that:

- no replay / A-B model comparison (direction #2),
- no RLAIF reward extraction (direction #3),
- no consented federation export (direction #4),
- no tool-use dataset (direction #5).

**Direction #1 is a literal blocker** for directions #2–#5. This proposal fixes the format so everything downstream can layer on top.

## Goals

1. **Stable schema v1**: versioned JSON-Schema + Zod runtime validator. Additive evolution only; breaking changes bump major.
2. **Pure function over chain state**: exporter reads existing chains, writes file(s). No runtime modification required.
3. **Provenance inline**: every event carries `blockIndex + blockHash + signer + signature`. Reader can verify without repo access.
4. **Consent-aware**: per-block `exportable | local-only | anonymized` flag respected end-to-end.
5. **Replayable**: output has enough detail that a future replayer can re-execute turn-by-turn against a different model.
6. **Publish-ready**: output format maps cleanly onto HuggingFace `datasets.Dataset` with zero post-processing.

## Non-goals (v1)

- Turn-level replay engine (separate PR, direction #2).
- RL reward extraction (separate PR, direction #3).
- Consent UI (separate PR, direction #4).
- Uploader to HuggingFace / public registry (separate PR, direction #4 / #5).
- Per-event anonymization transforms — v1 only honors the flag by skipping/redacting; smart anonymization (PII scrubbing, name replacement) is v2.

## Concepts

### Trajectory = session × time

A trajectory is the complete ordered story of a single session/run:

```
Trajectory
└── Turn[]              (one per user input → assistant reply)
    ├── userInput       (raw text, classification, risk flags)
    ├── promptBuild[]   (system prompt fragments that were assembled)
    ├── toolCalls[]     (name, input, output, durationMs, outcome, approvalState)
    ├── cognitivePass   (Model A prelude + post-response persistence)
    ├── modelResponse   (final assistant text, tokenUsage, provider)
    └── derivedEvents[] (journal/decision/reflection/case writes triggered by the turn)
```

Not every chain block belongs to a turn — system/boot events, scheduled reflections, standalone soul writes are **unlinked** events. They still export, but with `sessionId: null` and no `turnId`.

### Turn-binding

The binding is `turnId` — a UUID generated in `src/gateway/turn-runtime.ts:generateTurnId()` (already exists). Every chain write done during a turn must carry `data.turnId`. **Today not all writes do this.** Implementation PR #1 must audit `storeDurableMemory`, `appendBlock` call sites, and `ToolExecutionHook.postToolUse` to propagate `turnId` consistently.

## Schema v1 (Zod sketch)

Location: `src/trajectory/schema.ts` (new module).

```typescript
export const TrajectoryEventKind = z.enum([
  'user_input',
  'prompt_fragment',
  'tool_call',
  'tool_result',
  'model_response',
  'cognitive_prelude',
  'cognitive_post',
  'chain_write',        // journal/decisions/reflections/patterns/cases/collective/insights/soul
  'system_event',
]);

export const Provenance = z.object({
  chain: z.string(),
  blockIndex: z.number().int(),
  blockHash: z.string(),           // SHA-256 hex
  prevHash: z.string(),
  signer: z.string().optional(),   // ed25519 pubkey hex
  signature: z.string().optional(),
});

export const ConsentLevel = z.enum(['exportable', 'local-only', 'anonymized']);

export const TrajectoryEvent = z.object({
  kind: TrajectoryEventKind,
  ts: z.string(),                  // ISO 8601
  turnId: z.string().nullable(),
  surface: z.enum(['cli', 'http', 'mcp', 'telegram', 'scheduler', 'system']),
  consent: ConsentLevel,
  provenance: Provenance.nullable(), // null for in-memory events (frame buffer)
  payload: z.record(z.unknown()),    // kind-specific; see per-kind tables below
});

export const Trajectory = z.object({
  schemaVersion: z.literal(1),
  trajectoryId: z.string().uuid(),   // stable per session
  sessionId: z.string().nullable(),
  agentIdentity: z.object({
    agentName: z.string(),
    ownerName: z.string(),
    instanceId: z.string(),          // soul-manifest hash for integrity
  }),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  turns: z.number().int(),
  events: z.array(TrajectoryEvent),
  integrity: z.object({
    chainHashes: z.record(z.string()), // { "journal": "<last block hash>", ... }
    eventCount: z.number().int(),
    signedEventCount: z.number().int(),
  }),
});
```

### Payload shapes per `kind`

| kind                 | payload fields (concrete)                                                                 | source                          |
|----------------------|-------------------------------------------------------------------------------------------|---------------------------------|
| `user_input`         | `text, risk, classification, wrappedForModel`                                             | `src/gateway/prompt-boundary.ts` |
| `prompt_fragment`    | `label, text, sourceModule`                                                               | `src/gateway/system-prompt.ts`   |
| `tool_call`          | `toolName, inputJson, surface, approvalState, isDestructive, isReadOnly`                  | `ToolExecutionHook.postToolUse`  |
| `tool_result`        | `toolName, outputJson, durationMs, ok, errorMessage?`                                     | same                             |
| `model_response`     | `text, provider, model, tokenUsage {input,output}, stopReason`                            | `src/gateway/agent-runtime.ts`   |
| `cognitive_prelude`  | `mode, contributionLabel, recalledBlocks[], framesUsed`                                   | `src/gateway/cognitive-runtime.ts` |
| `cognitive_post`     | `writeDestChain, type, contentDigest, derivedPatterns?, derivedInsights?`                 | same                             |
| `chain_write`        | `chain, blockType, contentDigest, tags[]` (+ per-type discriminant from `data.type`)      | `src/infra/memory/durable-memory.ts` |
| `system_event`       | `event, details (unstructured JSON)`                                                      | `src/infra/logging/*`, boot loop |

**Per-type discriminant**: for `chain_write`, the payload carries the chain's `data.type` value (e.g. `decision`, `reflection`, `nominative`). This preserves the 8-case structure and Model E output structure verbatim — consumers can filter/aggregate without custom parsers.

## Exporter CLI

```bash
memphis export trajectories [options]

Options:
  --out <path>               Output file (default: stdout).
  --format jsonl|hf-dataset  Default: jsonl.
  --session <id>             Export one session. Repeatable.
  --since <ISO|duration>     Filter start time (e.g. '2026-04-01' or '7d').
  --until <ISO>              Filter end time.
  --chain <name>             Restrict to blocks from this chain. Repeatable.
  --consent exportable       Default: export only blocks tagged 'exportable'.
               |all          Include local-only and anonymized (operator-gated).
  --verify                   Re-verify every block's signature before emit.
  --redact-content           Replace content with SHA-256 hash (privacy exports).
```

### Output formats

**JSONL (default)** — one trajectory per line:

```json
{"schemaVersion":1,"trajectoryId":"a8f3…","sessionId":"s-123",…,"events":[…],"integrity":{…}}
```

**HF dataset** — emits a directory:

```
out/
├── trajectories.jsonl       (one trajectory per line)
├── events.jsonl             (one event per line, flat; for SQL-style querying)
├── trajectories.schema.json (JSON Schema v1)
├── README.md                (dataset card: source, license, consent policy)
└── meta.json                (exporter version, commit sha, export timestamp)
```

HF dataset mode makes `datasets.load_dataset('path/to/out')` work without conversion.

## Integration points in existing code

- **Read path** (exporter ingestion): `src/mcp/tools/chain-query.ts:runMemphisChainQuery` already filters by `chain + blockType + contains + tag`. Exporter wraps it with the consent/time/session filters above.
- **Provenance assembly**: every block read through `NapiChainAdapter.getBlocks()` already carries `hash + prev_hash + signer + signature`. Direct mapping, no recomputation.
- **Turn binding write path**: `src/infra/memory/durable-memory.ts:storeDurableMemory` must grow an optional `turnId` parameter. Callers in `src/gateway/turn-runtime.ts` and `src/gateway/tool-executor.ts` pass the current turn's id.
- **Schema evolution path**: new fields additive on `TrajectoryEvent.payload` only. The top-level `Trajectory` shape is frozen at v1 (renames → v2).

## Consent handling

Per-block consent is a **new `data.consent` field** on writes. Default `exportable` unless surface policy says otherwise. Source of truth:

1. `surface-policy.ts` gets a `defaultConsent` per surface (`telegram=exportable`, `tier3=local-only`, etc.).
2. `storeDurableMemory` stamps `data.consent` from the policy.
3. Exporter reads `block.data.consent`. Default filter: only `exportable`. `--consent all` requires operator confirmation (interactive prompt or `MEMPHIS_EXPORT_CONFIRM=1` env flag).
4. `anonymized` blocks are exported with content replaced by `SHA-256(content)` and tags preserved.

**Backfill**: blocks written before consent field shipped are treated as `exportable` by default (grandfathering). Operator can bulk-mark via `memphis consent mark --before <date> --level local-only`.

## Verification plan

1. **Fixtures** (`tests/fixtures/trajectory-v1/`):
   - `minimal-session.jsonl` — one user input, one tool call, one model response.
   - `multi-chain-session.jsonl` — session that writes to journal + decisions + case + reflection.
   - `unsigned-legacy.jsonl` — blocks without signer (pre-ed25519 era) — exporter must degrade gracefully.
2. **Schema conformance** (`tests/unit/trajectory-schema.test.ts`):
   - Zod validator accepts every fixture.
   - Rejects missing `schemaVersion`, invalid `kind`, malformed `provenance`.
3. **Round-trip** (`tests/integration/trajectory-export.test.ts`):
   - Seed ephemeral chain state → export → reimport → assert equality (modulo ordering).
4. **Consent gates**:
   - Default export omits `local-only` blocks.
   - `--consent all` requires confirmation env flag; without flag → aborts with clear message.
5. **Replay readiness** (stub for direction #2):
   - `src/trajectory/replay-readiness.ts` function validates that a trajectory has sufficient data to re-execute: every `tool_call` has matching `tool_result`, every user_input has model_response, provenance complete.

## Implementation PRs (sequence)

1. **PR "A" — schema module** (this proposal lands first, then implementation):
   - `src/trajectory/schema.ts` (Zod types + JSON Schema export).
   - `tests/unit/trajectory-schema.test.ts`.
   - No CLI, no exporter yet. Pure contract.

2. **PR "B" — turnId propagation**:
   - Add `turnId` param to `storeDurableMemory` and all callers.
   - Add `consent` param with default from surface-policy.
   - Fixtures + tests.

3. **PR "C" — exporter core**:
   - `src/trajectory/exporter.ts` (chain query → TrajectoryEvent mapping).
   - `src/infra/cli/commands/export.ts`.
   - Integration tests with fixtures.

4. **PR "D" — HF dataset format**:
   - HF-specific output directory layout + dataset card generation.
   - Snapshot test of emitted directory.

5. **PR "E" — consent backfill helper** (optional):
   - `memphis consent mark` CLI command.
   - Migration doc.

Each PR is independently mergeable. Direction #1 is "done" when PR C is merged.

## Open questions (to resolve before PR A)

1. **`trajectoryId` identity**: per-session (stable across reboots)? Per-export-invocation? Proposal leans toward **per-session** so replays of the same trajectory have the same id.
2. **`instanceId` in `agentIdentity`**: is `soul-manifest.json` hash sufficient, or should we use Ed25519 pubkey? Pubkey is more stable across manifest edits.
3. **System events in trajectory**: include or emit to separate stream? Proposal leans **include but mark** with `surface: 'system'` so consumers can filter.
4. **Content digest algorithm**: SHA-256 of raw content? Or canonical-JSON hash? Proposal: SHA-256 of raw text (consistent with existing chain block hashing).
5. **Schema distribution**: ship JSON Schema in `dist/` npm package so external consumers can validate without source checkout. Adds ~5 KB to package. Worth it.

## Why this design (vs alternatives)

- **Vs. OpenTelemetry trace format**: OTel is runtime-centric (spans, timings, attributes). Trajectory export is dataset-centric (audit-grade provenance, consent, RL-ready). Memphis can still emit OTel *in addition*, but OTel is not the primary format here.
- **Vs. raw chain dump**: chains are append-only logs with different `data.type` per chain. Raw dump forces every consumer to re-implement turn binding + consent filtering + provenance verification. This proposal does it once.
- **Vs. OpenAI-style conversation JSON**: those formats lose structured tool-call provenance + chain integrity. Memphis has both natively; export must preserve them.

## References

- Live chain list: `/home/memphis/.memphis/chains/` (9 directories: journal, system, decisions, reflections, insights, patterns, cases, collective, soul).
- Block schema: `src/infra/storage/chain-file-io.ts:24` (`NapiBlock`, `NapiBlockData`).
- Case types: `src/memory/case-types.ts` (8 Polish grammatical cases as semantic roles).
- Cognitive output types: `src/cognitive/types.ts` (`Reflection`, `Insight`, `Contradiction`, `DecisionPattern`).
- Turn runtime: `src/gateway/turn-runtime.ts` (already generates `turnId`; binding propagation is the main implementation gap).
- Codebase map: `notes/memphis-disassembler-map-2026-04-20.md` (Codex, static metrics) + memory `codebase_atlas.md` (Claude Code, semantic structure).

---

**Next step after this PR lands**: implementation PR "A" (schema module). Owner selects a sequence; proposal does not block on ownership assignment.
