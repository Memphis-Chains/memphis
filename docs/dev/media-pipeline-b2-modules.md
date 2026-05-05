# Memphis Media Pipeline — B2 module specifications

> **Status:** B2 — concrete module-level design
> **Date:** 2026-05-05
> **Builds on:** [B1 — architectural concept](./media-pipeline-b1-architecture.md)
> **Memphis version:** v1.8.0

This document refines the B1 sketch into module-level signatures, file paths, env wiring, and integration points the implementation can take straight to code in B3. Where B1 introduced new components, B2 reuses what already ships in Memphis (the voice stack `whisper-server` on `:9000`, `memphis_journal`, `memphis_case_append`, `memphis_fs_write`, the Ollama provider) so the increment lands inside the existing architecture rather than as a parallel sub-project.

## Architectural deltas vs. B1

B1's sketch placed the new code under `media-orchestrator/src/`. B2 lands it under `src/gateway/media/` to match the rest of Memphis (gateway-side adapters live in `src/gateway/`; tools in `src/mcp/tools/`). Same for env vars (single registry in `src/config/env-registry.ts`) and tool registration (single `src/gateway/tool-registry.ts`).

The data directory uses `~/.memphis/media/` (matching the rest of Memphis, not the legacy `~/memphis/media/` path B1 mentioned). The runtime tilde-expansion goes through `MEMPHIS_DATA_DIR` and `getDataDir()` so dev installs and packaged operators land in the same shape.

The whisper component is **not new**. Memphis already runs `faster-whisper` on `127.0.0.1:9000` for voice-message STT (`src/gateway/voice/local-whisper-adapter.ts`, Sprint H). B2 reuses that endpoint for media-pipeline audio rather than spinning up a second `whisper.cpp` instance. The pipeline sends audio bytes; the existing adapter handles the HTTP call.

## Module layout

```
src/gateway/media/
  ├── audio-adapter.ts        # Wraps existing local-whisper-adapter for arbitrary
  │                           # audio bytes (not just Telegram OGG). Surfaces
  │                           # transcribeAudioFile(filePath) → { text, language }.
  │
  ├── vision-adapter.ts       # Calls Ollama with `llava` or `moondream2` model.
  │                           # describeImage(filePath, options?) → { description, tags }.
  │
  ├── video-adapter.ts        # ffmpeg keyframe extract → vision-adapter per frame
  │                           # → timeline rollup. analyzeVideo(filePath) → {
  │                           #   keyframes, timelineSummary, entities }.
  │
  ├── orchestrator.ts         # Single ingest entry point. Routes by content-type
  │                           # detection, fans out to adapters, batches chain
  │                           # writes. ingestMedia(filePath, options?) → MediaIngestResult.
  │
  └── chain-output.ts         # Maps adapter results to journal / cases /
                              # insights blocks via existing Memphis tools.

src/mcp/tools/
  └── media-ingest.ts         # `memphis_media_ingest` MCP tool — thin wrapper
                              # around orchestrator.ingestMedia(). Tier 2
                              # (network for Ollama call + filesystem read).

src/infra/cli/handlers/
  └── media.handler.ts        # `memphis media ingest|status|watch` CLI
                              # subcommands. Pattern mirror of voice.handler.ts.
```

No new Rust crate. No new top-level subproject. Everything wires through existing Memphis surfaces.

## Env-registry additions (`src/config/env-registry.ts`)

```ts
export const MEMPHIS_MEDIA_ENABLED = defineStringAccessor({
  name: 'MEMPHIS_MEDIA_ENABLED',
  envKey: 'MEMPHIS_MEDIA_ENABLED',
  description: 'Enable media-pipeline ingestion (vision + video). Default off.',
  defaultValue: '',
});

export const MEMPHIS_MEDIA_VISION_MODEL = defineStringAccessor({
  name: 'MEMPHIS_MEDIA_VISION_MODEL',
  envKey: 'MEMPHIS_MEDIA_VISION_MODEL',
  description: 'Ollama model for image description (llava / moondream2 / …)',
  defaultValue: 'moondream2',
});

export const MEMPHIS_MEDIA_VIDEO_KEYFRAME_INTERVAL_S = defineStringAccessor({
  name: 'MEMPHIS_MEDIA_VIDEO_KEYFRAME_INTERVAL_S',
  envKey: 'MEMPHIS_MEDIA_VIDEO_KEYFRAME_INTERVAL_S',
  description: 'Seconds between extracted keyframes for video analysis',
  defaultValue: '5',
});

export const MEMPHIS_MEDIA_VIDEO_MAX_FRAMES = defineStringAccessor({
  name: 'MEMPHIS_MEDIA_VIDEO_MAX_FRAMES',
  envKey: 'MEMPHIS_MEDIA_VIDEO_MAX_FRAMES',
  description: 'Hard cap on extracted keyframes per video',
  defaultValue: '20',
});
```

WHISPER_SERVER_URL already exists; the audio-adapter reuses it. OLLAMA_URL already exists; the vision-adapter reuses it.

## Public types

```ts
// src/gateway/media/types.ts

export type MediaKind = 'audio' | 'image' | 'video';

export interface AudioTranscription {
  kind: 'audio';
  text: string;
  language?: string;
  durationMs?: number;
}

export interface ImageDescription {
  kind: 'image';
  description: string;
  tags: string[];
  /** Width × height when ffprobe / image header gives them. */
  dimensions?: { width: number; height: number };
}

export interface VideoTimeline {
  kind: 'video';
  /** One entry per analyzed keyframe. */
  keyframes: Array<{ tSeconds: number; description: string; tags: string[] }>;
  /** LLM-summarized rollup of all keyframes ("a person enters, then sits"). */
  timelineSummary: string;
  /** Entities extracted from the timelineSummary (for cases-chain seeding). */
  entities: string[];
  durationS?: number;
}

export type MediaIngestResult = {
  filePath: string;
  kind: MediaKind;
  /** The adapter output. Variant by kind. */
  payload: AudioTranscription | ImageDescription | VideoTimeline;
  /** Chain-side audit — IDs of the blocks written. */
  chainOutput: {
    journalBlockIndex?: number;
    caseBlockIndices: number[];
    insightBlockIndex?: number;
  };
  /** ms taken end-to-end. */
  elapsedMs: number;
  error?: string;
};
```

## Adapter signatures

### `audio-adapter.ts`

```ts
export async function transcribeAudioFile(
  filePath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AudioTranscription>
```

- Reads file via `fs.readFile`.
- If file is not 16 kHz mono WAV, transcodes via ffmpeg (`runFfmpegAsync` from `local-whisper-adapter.ts` is reused — it already handles the OGG/OPUS → WAV path).
- POSTs to `WHISPER_SERVER_URL/inference` with `Content-Type: audio/wav`, 90 s timeout.
- Returns `{ kind: 'audio', text, language, durationMs }`.

### `vision-adapter.ts`

```ts
export async function describeImage(
  filePath: string,
  options?: { model?: string; prompt?: string },
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ImageDescription>
```

- Reads file → base64.
- POSTs to `OLLAMA_URL/api/generate` with `{ model: options.model ?? MEMPHIS_MEDIA_VISION_MODEL, prompt: options.prompt ?? "Opisz krótko co widać. Wymień obiekty, miejsca, osoby (bez identyfikacji). Po polsku.", images: [base64], stream: false }`.
- Parses Ollama's text response into `description` + extracts tags via simple keyword detection (or a follow-up Ollama call with a tag-extraction prompt).
- Surface: `{ kind: 'image', description, tags, dimensions? }`.
- Tag extraction kept simple in B3 (split on commas / extract nouns). A B4 iteration can add a structured-prompt approach.

### `video-adapter.ts`

```ts
export async function analyzeVideo(
  filePath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<VideoTimeline>
```

- Probes duration via `ffprobe` (fallback to ffmpeg parse) — required to bound keyframe extraction.
- Extracts keyframes at `MEMPHIS_MEDIA_VIDEO_KEYFRAME_INTERVAL_S` intervals up to `MEMPHIS_MEDIA_VIDEO_MAX_FRAMES`. Uses ffmpeg with `-vf "fps=1/${interval}"`. Frames land in `~/.memphis/media/cache/<basename>-<i>.jpg`.
- Calls `describeImage` per keyframe (parallel, capped at 4 concurrent — Ollama doesn't love high concurrency on a single GPU).
- Builds `timelineSummary` via a final Ollama call: `"Streszcz timeline z opisów keyframes: <descriptions>. Po polsku, 2-3 zdania."`.
- Extracts `entities` from `timelineSummary` via a follow-up Ollama prompt.
- Cleans up frame files unless `MEMPHIS_MEDIA_KEEP_KEYFRAMES=1` (for ops debugging).

## Chain output mapping (`chain-output.ts`)

```ts
export async function writeMediaToChains(
  result: { filePath: string; payload: MediaIngestResult['payload'] },
  options: { surface?: string },
): Promise<MediaIngestResult['chainOutput']>
```

- For `audio`: one `memphis_journal` write with `tags: ['media', 'audio', language]`.
- For `image`: `memphis_journal` (description) + `memphis_case_append` per detected entity in `tags`.
- For `video`: `memphis_journal` (timelineSummary) + `memphis_case_append` per `entities` + optional `memphis_journal` insights when the model flagged something operator-relevant.

All writes go through the existing tool functions so the audit chain captures them and the cognitive prelude picks them up next turn.

## Tool surface (`memphis_media_ingest`)

```ts
// src/mcp/tools/media-ingest.ts

export interface MemphisMediaIngestInput {
  /** Absolute or relative-to-MEMPHIS_DATA_DIR file path. */
  path: string;
  /** Override auto-detection. */
  type?: MediaKind | 'auto';
  /** Skip chain writes (dry run for adapter validation). */
  dryRun?: boolean;
}

export type MemphisMediaIngestOutput = MediaIngestResult;

export async function runMemphisMediaIngest(
  input: MemphisMediaIngestInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisMediaIngestOutput>
```

Registry entry:

```ts
memphis_media_ingest: {
  name: 'memphis_media_ingest',
  tier: 2,
  capabilities: ['network', 'read', 'write'],
  description: 'Ingest a media file (audio/image/video) into chains',
  inputSchema: z.object({
    path: z.string().min(1),
    type: z.enum(['audio', 'image', 'video', 'auto']).optional(),
    dryRun: z.boolean().optional(),
  }).strict(),
  helpText: '…',
  cliFlags: [
    { name: '--path', description: 'Path to the media file', takesValue: true, required: true },
    { name: '--type', description: 'audio | image | video | auto', takesValue: true },
    { name: '--dry-run', description: 'Skip chain writes', takesValue: false },
  ],
}
```

## CLI surface (`memphis media …`)

```bash
memphis media ingest <path> [--type=auto] [--dry-run] [--json]
memphis media status                   # ollama reachable? whisper reachable? media dir state?
memphis media watch [--dir=...]        # watches incoming/ for new files, ingests
```

`media.handler.ts` mirrors `voice.handler.ts` — same shape, same registration through `src/infra/cli/registry.ts`.

## Doctor probe (`ta16-media-pipeline`)

Probe behaviour:
- `pass` when `MEMPHIS_MEDIA_ENABLED=1` AND Ollama reachable AND vision model present in `ollama list`.
- `warn` when `MEMPHIS_MEDIA_ENABLED` is unset (feature opt-in; not having it is fine).
- `fail` when enabled but Ollama unreachable OR vision model not pulled.
- Fix hints: `ollama pull moondream2` / `MEMPHIS_MEDIA_ENABLED=1 in .env`.

## Anti-confab whitelist additions

When the bot describes a video timeline ("I saw a person enter the room"), that's a real description from the LLM, not confabulation. `memphis_media_ingest` is added to the **search-claim** category whitelist — it's a read of the media surface. The vision adapter's output is also quoted via `memphis_journal`, which is already on the **persistence-claim** whitelist.

## Testing strategy

```
tests/unit/media-audio-adapter.test.ts        # mock fetch → whisper-server
tests/unit/media-vision-adapter.test.ts       # mock fetch → ollama
tests/unit/media-video-adapter.test.ts        # mock ffmpeg + vision-adapter
tests/unit/media-orchestrator.test.ts         # end-to-end orchestration with mocks
tests/integration/media-ingest-image.test.ts  # real ollama (skipped in CI without
                                              # MEMPHIS_TEST_OLLAMA_AVAILABLE=1)
```

Smoke / golden assets in `tests/fixtures/media/`:
- `audio-test.wav` (3 s, "Cześć Memphis")
- `image-test.jpg` (small landscape)
- `video-test.mp4` (5 s, two scenes)

## Phased rollout

| Phase | Scope | Estimate |
|------|-------|----------|
| **B3** | Audio + image adapter only. Reuse existing whisper-server. New vision-adapter. `memphis_media_ingest` tool gated to those two kinds. | ~3-4 h |
| **B4** | Video adapter (ffmpeg keyframe + per-frame analysis + timeline rollup). | ~3-4 h |
| **B5** | CLI handler `memphis media …` + doctor probe + anti-confab whitelist + `MEMPHIS_MEDIA_ENABLED` env-registry. | ~1-2 h |
| **B6** | Watch mode (`memphis media watch`) — `incoming/` directory monitor with debouncing. | ~2 h |

B3 unlocks the most value (audio + image cover ~80% of operator media inputs); B4–B6 are incremental. Nothing here blocks the demo on 2026-05-06; all phases ship post-demo.

## Operator-side prerequisites

Before B3 lands the operator runs:

```bash
# Pull the vision model (~1.6 GB)
ollama pull moondream2

# (Optional: heavier llava for higher-quality descriptions)
ollama pull llava

# Enable the feature (new env)
echo 'MEMPHIS_MEDIA_ENABLED=1' >> .env

# Restart memphis to pick up the new env + (after B5) new CLI handler
systemctl --user restart memphis
```

## Out of scope (deferred)

- **Real-time webcam capture** — out of scope; this is for ingesting saved files. A future "memphis camera capture" skill would build on the same vision-adapter.
- **Audio diarization (multi-speaker)** — out of scope for B3-B6. faster-whisper has experimental diarization support; can revisit.
- **OCR** — separate concern. If operator drops a screenshot with text into `incoming/`, the vision model will describe it but won't extract text verbatim. A B7+ phase can add `tesseract` for that.
- **Cloud fallback** — the whole point is local-only (per B1's security note).
