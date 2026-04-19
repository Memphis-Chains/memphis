# Memphis Cognitive Architecture

> **Status**: Verified 2026-04-01 | Source: `src/infra/runtime/heartbeat-watchdog.ts`, `src/cognitive/`, `src/soul/memory.ts`

---

## 1. PULSE — Heartbeat System

**Location**: `src/infra/runtime/heartbeat-watchdog.ts`

PULSE is Memphis's liveness and audit system. It writes heartbeat entries to `~/.memphis/config/PULSE.md`.

### Behavior

- **Interval**: Writes every ~10 ticks (default tick = 1 minute → pulse every ~10 minutes)
- **Triggered writes**: Also writes on any health state change
- **Non-fatal**: If PULSE write fails, runtime continues unaffected
- **Retention**: Max 50 most recent entries; older entries are trimmed

### Format

```markdown
# PULSE — Memphis Agent

Last: 2026-04-01T09:54:11.216Z | Status: healthy | Uptime: 1201s

## Recent

- 2026-04-01T07:42:13.738Z BOOT health=healthy uptime=0s
- 2026-04-01T09:37:11.154Z HEARTBEAT health=healthy uptime=181s
- 2026-04-01T09:44:11.154Z HEARTBEAT health=healthy uptime=601s
- 2026-04-01T09:54:11.216Z HEARTBEAT health=healthy uptime=1201s
```

### Health States

| State       | Meaning          | Trigger                        |
| ----------- | ---------------- | ------------------------------ |
| `healthy`   | All checks pass  | No failures or warnings        |
| `degraded`  | Some checks warn | At least one `warn`, no `fail` |
| `unhealthy` | Critical failure | At least one `fail`            |

### Health Checks (per tick)

1. **Chain adapter** — Rust bridge loaded?
2. **Vault bridge** — Rust vault API available?
3. **Embed bridge** — Rust embed API available?
4. **Process memory** — Heap usage ratio

---

## 2. ABCDE Cognitive Engines

**Location**: `src/cognitive/` (model-a.ts through model-e.ts)

Memphis uses five specialized cognitive engines that form a pipeline. Each engine has a distinct responsibility in the cognition loop.

### Engine Overview

| Model | Class                            | Responsibility                                          |
| ----- | -------------------------------- | ------------------------------------------------------- |
| **A** | `ModelA_ConsciousCapture`        | Explicit user decision capture (requires confirmation)  |
| **B** | `ModelB_InferredDecisions`       | Infer decisions from git, files, activity patterns      |
| **C** | `ModelC_PredictivePatterns`      | Learn and predict next patterns from history            |
| **D** | `ModelD_CollectiveCoordination`  | Multi-agent governance, proposals, voting               |
| **E** | `ModelE_MetaCognitiveReflection` | Reflection on own reasoning ("thinking about thinking") |

### Data Flow

```
User Action → Model A (capture) → Model B (infer) → Model C (predict)
                                                         ↓
Model E (reflect) ← Model D (coordinate) ← ← ← ← ← ← ← ←
```

### Model A — ConsciousCapture

```typescript
// src/cognitive/model-a.ts
export class ModelA_ConsciousCapture {
  // Requires explicit user confirmation before recording decisions
  // Explicit over implicit - user must opt-in
}
```

Captures user decisions explicitly. Requires `requireConfirmation: true`. Used for high-stakes or intentional user actions that should be remembered.

### Model B — InferredDecisions

```typescript
// src/cognitive/model-b.ts
export class ModelB_InferredDecisions {
  // Infers decisions from: git history, file changes, activity
  // No confirmation needed - automatic inference
}
```

Automatically infers what the user intended based on observable signals (git commits, file modifications, command patterns).

### Model C — PredictivePatterns

```typescript
// src/cognitive/model-c.ts
export class PatternRegistry {
  /* stores learned patterns */
}
export class ModelC_PredictivePatterns {
  // Learns from block chain history
  // Predicts next actions based on patterns
}
```

Learns recurring patterns from the decision chain and predicts what the user or system will do next. Uses block history stored in the Rust chain.

### Model D — CollectiveCoordination

```typescript
// src/cognitive/model-d.ts
export class ModelD_CollectiveCoordination {
  // Multi-agent governance
  // Proposals, voting, weighted decisions
}
```

Coordinates multiple agents. Handles proposal lifecycle (proposed → accepted → implemented → verified), voting with weighted votes, and consensus tracking.

### Model E — MetaCognitiveReflection

```typescript
// src/cognitive/model-e.ts
export class ModelE_MetaCognitiveReflection {
  // "Thinking about thinking"
  // Reflection engine for self-improvement
}
```

Performs meta-cognition — reflects on the agent's own reasoning processes, identifies biases, and suggests improvements to the cognitive pipeline.

---

## 3. Burn-After-Read Memory

**Location**: `src/soul/memory.ts`

Memphis has a special "burn-after-read" memory system in `~/.memphis/config/memory.md`. Entries can be marked as "burned" after consumption.

### File Format

```markdown
# MEMORY — Memphis Agent

Burn-After-Action Log | Threshold: 100

## Actions

- [decision] john started me 2026-03-31T20:25:33.000Z | active
- [note] use tool calls wisely 2026-04-01T09:00:00.000Z | burned:true burnedAt:2026-04-01T10:00:00.000Z
```

### Entry Types

- `[decision]` — User/system decision
- `[note]` — Note or observation
- `[milestone]` — Achievement or significant event

### State Fields

| Field              | Meaning                        |
| ------------------ | ------------------------------ |
| `active`           | Entry is available for recall  |
| `burned:true`      | Entry has been consumed/burned |
| `burnedAt:ISO8601` | When the entry was burned      |

### Core Functions

```typescript
// src/soul/memory.ts

// Burn (mark as consumed) a single entry by ID
burnMemoryAction(id: string): boolean

// Archive all entries when threshold is exceeded
rotateMemoryFile(): void

// Burn all entries (for full reset)
burnAllMemory(): void
```

### Burn Semantics

When an entry is burned:

1. `burned: true` and `burnedAt: <timestamp>` are set in the memory.md file
2. A `memory.burn` block is appended to the `soul` journal chain (audit trail)
3. The entry remains in the file (for forensics) but is marked as consumed

### Rotation

When total entries exceed `MEMORY_ROTATION_THRESHOLD` (default: 100):

1. All current entries are marked as burned
2. Entries are archived to `~/.memphis/config/memory-archive-<timestamp>.md`
3. Memory file is cleared for fresh entries

---

## 4. Integration Points

### Chain Storage

All cognitive events are persisted to the Rust chain via `appendBlock()`:

- `soul` chain: memory.burn events, boot events, mode changes
- `decisions` chain: Model B inferred decisions
- `patterns` chain: Model C learned patterns
- `reflections` chain: Model E meta-cognitive outputs

### Health Monitoring

PULSE reads from the same chain adapter status as health checks:

- `chain_adapter`: Rust bridge loaded
- `vault_bridge`: Rust vault API status
- `embed_bridge`: Rust embed API status

### Configuration

```typescript
// Default loop limits (shared across gateway, task-executor, loop-step)
const DEFAULT_LOOP_LIMITS = {
  max_steps: 32,
  max_tool_calls: 64, // Increased from 16 for complex tasks
  max_wait_ms: 120_000, // 2 minutes
  max_errors: 4,
};
```

---

## 5. Verified Behavior

| Component                 | Status | Verified                                          |
| ------------------------- | ------ | ------------------------------------------------- |
| PULSE heartbeat           | ✅     | `~/.memphis/config/PULSE.md` updates every ~7 min |
| Model A-E files           | ✅     | 8 model-\*.ts files in `src/cognitive/`           |
| burnMemoryAction          | ✅     | Function present, sets burned:true + burnedAt     |
| Journal chain integration | ✅     | `memory.burn` events appended to soul chain       |
| Rotation mechanism        | ✅     | Archive + clear when threshold exceeded           |
