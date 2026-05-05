/**
 * Media pipeline orchestrator — single entry point.
 *
 * Routes by kind (auto-detected from extension or caller-overridden)
 * and fans out to the adapters. Returns a uniform MediaIngestResult
 * with adapter payload + chain-write audit IDs.
 *
 * B3 scope: audio + image only. Video falls through to a stub that
 * surfaces a clear error message until B4 implements the
 * frame-extraction adapter.
 */

import { transcribeAudioFile } from './audio-adapter.js';
import { writeMediaToChains } from './chain-output.js';
import type { MediaIngestResult, MediaKind, MediaPayload } from './types.js';
import { describeImage } from './vision-adapter.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.flac', '.webm']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

function detectKind(filePath: string): MediaKind | undefined {
  const lower = filePath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  // .webm is ambiguous (audio in voice messages, video in screen
  // recordings). Bias toward video when the extension is .webm —
  // audio webm is rare in operator workflows. Audio-mode `--type
  // audio` overrides this.
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return undefined;
}

export interface IngestMediaOptions {
  /** Override auto-detection. */
  kind?: MediaKind | 'auto';
  /** Skip chain writes (dry run for adapter validation). */
  dryRun?: boolean;
  /** Active surface name for chain-write provenance. */
  surface?: string;
}

export async function ingestMedia(
  filePath: string,
  options: IngestMediaOptions = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MediaIngestResult> {
  const start = Date.now();
  const detectedKind = options.kind && options.kind !== 'auto' ? options.kind : detectKind(filePath);

  if (!detectedKind) {
    return {
      filePath,
      kind: 'audio', // arbitrary; placeholder so the result type is always satisfied
      payload: { kind: 'audio', text: '' },
      chainOutput: { caseBlockIndices: [] },
      elapsedMs: Date.now() - start,
      error: `Unsupported / unrecognised media extension: ${filePath}`,
    };
  }

  let payload: MediaPayload;

  switch (detectedKind) {
    case 'audio':
      payload = await transcribeAudioFile(filePath, rawEnv);
      break;
    case 'image':
      payload = await describeImage(filePath, {}, rawEnv);
      break;
    case 'video':
      // B3 scope ends at audio + image. Video handler ships in B4.
      // Surface the gap clearly so the operator (or bot) knows
      // it's not a runtime bug.
      return {
        filePath,
        kind: 'video',
        payload: {
          kind: 'video',
          keyframes: [],
          timelineSummary: '',
          entities: [],
        },
        chainOutput: { caseBlockIndices: [] },
        elapsedMs: Date.now() - start,
        error:
          'Video ingest is not yet implemented (B4 scope — audio + image work today). ' +
          'Use ffmpeg + memphis_media_ingest --type=image on a keyframe export as a workaround.',
      };
  }

  const chainOutput = options.dryRun
    ? { caseBlockIndices: [] }
    : await writeMediaToChains(
        { filePath, payload },
        { surface: options.surface ?? 'media-ingest' },
      );

  return {
    filePath,
    kind: detectedKind,
    payload,
    chainOutput,
    elapsedMs: Date.now() - start,
  };
}
