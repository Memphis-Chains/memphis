# Cognitive Modes A/B/C/D/E

Memphis exposes five cognitive modes. Each mode shapes a turn in three ways:

1. **Temperature** passed to the LLM.
2. **Max-tokens ceiling** derived from the mode's style.
3. **Prompt fragment** prepended to the cognitive context — unique per mode.

The active mode is stored in `~/.memphis/soul-manifest.json` (`cognitiveMode`) with a
last-modified timestamp (`cognitiveModeUpdatedAt`). Read via `/v1/cognitive/status`.

## Matrix

| Mode | Name              | Temp | Style         | Max tokens | What it attaches to the turn                                         |
|------|-------------------|------|---------------|-----------:|----------------------------------------------------------------------|
| A    | ConsciousCapture  | 0.3  | fast          |      1024  | last ≤5 Model A captures (notes/decisions/milestones)                |
| B    | InferredDecisions | 0.5  | deliberate    |      4096  | top-3 Model B inferred decisions with category + confidence          |
| C    | PredictivePatterns| 0.7  | reflective    |      4096  | top-3 Model C pattern predictions with confidence                    |
| D    | CollectiveCoord   | 0.4  | collaborative |      4096  | peer roster (`MEMPHIS_COGNITIVE_PEERS`) or pass-through marker       |
| E    | MetaCognitiveRef  | 0.2  | meta          |      2048  | latest persisted reflection (`chain: reflections`, `kind: reflection`)|

Style → max tokens map (`resolveMaxTokensForStyle`):

```
fast=1024  deliberate=4096  reflective=4096  collaborative=4096  meta=2048
```

## Switching modes

- **TUI**: `/cognitive set-mode <A..E>` (tier 1).
- **Telegram**: `/mode <A..E>` (tier 1).
- **HTTP**: `POST /v1/cognitive/mode { "mode": "B" }`.

Each switch appends a `mode_change` block to the system chain and emits a PULSE
event. The `cognitiveModeUpdatedAt` timestamp is refreshed on every change and
surfaces in the TUI overview + `/v1/cognitive/status` response.

## When to pick which mode

- **A — ConsciousCapture**: short, fact-oriented turns. You want speed and low
  variance. Decisions you will later codify to the chain.
- **B — InferredDecisions**: a task that benefits from "what have we decided
  recently?" context. Refactors, follow-ups, anything branching from prior work.
- **C — PredictivePatterns**: exploratory or planning turns. You want the model
  to see "what usually happens next?" inferred from the Model C registry.
- **D — CollectiveCoord**: multi-agent consensus. Only meaningful when
  `MEMPHIS_COGNITIVE_PEERS` is set; otherwise falls through to single-agent.
- **E — MetaCognitiveRef**: retros, SLO reviews, post-mortems. Turn prepends the
  most recent daily/weekly reflection from Model E.

## How modes are dispatched

Every turn goes through `src/gateway/turn-runtime.ts`:

1. Load mode from `getCognitiveMode(rawEnv)`.
2. Run cognitive prelude (Model B + C) to collect blocks/inferred/predictions.
3. Call `applyCognitiveMode(mode, { blocks, inferred, predictions }, rawEnv)`.
4. Merge the mode's `promptFragment` into the cognitive context.
5. Pass the mode's `temperature` + `maxTokens` into the provider call.

The per-mode fragment is deterministic and pure — the dispatch function does
not read from disk or the network. Tests: `tests/unit/mode-dispatch.test.ts`.

## Reflection loop (Mode E source)

`startReflectionLoop` is invoked in `src/app/bootstrap.ts` at process boot.
Period: `MEMPHIS_REFLECTION_INTERVAL_MS` (default 24 h, minimum 1 h). Persists
to the `reflections` chain; those blocks are exactly what Mode E pulls.

Disable the loop with `MEMPHIS_REFLECTION_ENABLED=false`.

## Status endpoint

`GET /v1/cognitive/status` returns:

```json
{
  "cognitiveMode": {
    "active": "B",
    "config": {
      "name": "InferredDecisions",
      "description": "Deep analysis with evidence chains — detailed reasoning",
      "temperature": 0.5,
      "style": "deliberate",
      "pattern": "detailed",
      "maxTokens": 4096
    },
    "lastModified": "2026-04-13T12:34:00.000Z"
  },
  "availableModes": ["A", "B", "C", "D", "E"],
  ...
}
```

The TUI overview surfaces this information on the first screen. Field names in
Rust: `cognitive_mode`, `cognitive_mode_name`, `cognitive_mode_temperature`,
`cognitive_mode_style`, `cognitive_mode_pattern`, `cognitive_mode_last_modified`.
