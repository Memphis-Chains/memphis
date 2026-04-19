# Cognitive mode A — frame pipeline

Cognitive mode A (`ModelA_ConsciousCapture`) needs short-range, cross-turn
context to actually contribute to the next response. Sprint 11 added the
missing piece: a bounded in-process ring of **frames** that turn-runtime
populates after every completed turn and that mode A dispatch reads at prepare
time.

## What a frame looks like

```ts
interface Frame {
  ts: number; // ms since epoch, turn completion time
  surface: string; // 'tui' | 'telegram' | 'http' | other audit surface
  turnId: string; // uuid generated at the start of the turn
  lastNTurns: Array<{ role: 'user' | 'assistant' | string; text: string }>;
  activeFilePaths: string[]; // optional — surface-provided, empty by default
  activeToolCalls: string[]; // tool names invoked during the turn
}
```

Frames are text-only and cheap. No screenshots, no binary payloads.

## Ring buffer (`src/cognitive/frame-buffer.ts`)

- `pushFrame(frame)` — append; evicts the oldest if the buffer is full.
- `getRecentFrames(count = 5)` — return at most `count` most-recent frames
  (each returned frame is a deep copy; safe to mutate).
- `resetFrameBuffer()` — clear and re-apply the configured capacity
  (test-only).
- Capacity: `MEMPHIS_FRAME_BUFFER_SIZE` (default `128`, clamped to `[1, 4096]`).

The ring is a singleton — one in-process buffer shared across every surface in
the same Node process, matching the cross-surface presence registry landed in
Sprint 5.

## Dispatch into mode A

`src/cognitive/mode-dispatch.ts` learned a new input field:

```ts
interface CognitiveModeDispatchInput {
  blocks?: Block[];
  inferred?: InferredDecision[];
  predictions?: Prediction[];
  frames?: Frame[]; // ← Sprint 11
}
```

When the active cognitive mode is `A`, `computeCognitiveModeContribution`
(`src/gateway/turn-runtime.ts`) pulls `getRecentFrames()` and passes them in.
Mode B/C/D/E ignore frames entirely.

`buildModeAFragment` emits a compact text block — one line per frame, trailing
five frames max:

```
[mode_A:recent_captures]
- note: earlier Model A capture…
[mode_A:recent_frames]
- t=2026-04-13T12:00:05.000Z surface=tui tools=memphis_exec files=/srv/app/deploy.sh user="deploy staging"
- t=2026-04-13T12:00:21.000Z surface=telegram user="status?"
```

Captures (`source === 'model-a'`) and frames are independent sections; either
can be empty.

## Post-turn capture (`src/gateway/turn-runtime.ts`)

At turn start the runtime generates a `turnId` via `crypto.randomUUID()`.
After `runPostResponseCognitivePass` completes, the runtime builds a frame:

- `lastNTurns` is extracted from the tail of the message list plus the
  original user text + guarded assistant reply. Each field is truncated to
  280 chars.
- `activeToolCalls` is the de-duplicated set of `tool_calls[].name` across the
  assistant messages in this turn.
- `activeFilePaths` is empty by default — surfaces can set it in future
  sprints; not wired to any heuristic today.

A frame-push failure is logged and swallowed; it never fails the turn.

## Tests

- `tests/unit/frame-buffer.test.ts` — capacity, FIFO eviction, clone
  semantics, env-driven resize, reset.
- `tests/unit/mode-dispatch.test.ts` — `buildModeAFragment` renders and
  truncates frames; other modes ignore them.
- `tests/integration/mode-a-frame-dispatch.test.ts` — three prior turns
  feed turn four's mode A prompt fragment.
