/**
 * Memphis Media Pipeline — public types.
 *
 * Per B2 spec (docs/dev/media-pipeline-b2-modules.md). Three media
 * kinds — audio, image, video — each with their own payload shape.
 * The orchestrator returns a uniform MediaIngestResult that includes
 * the adapter output plus chain-side audit IDs.
 */

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

export type MediaPayload = AudioTranscription | ImageDescription | VideoTimeline;

export interface MediaIngestResult {
  filePath: string;
  kind: MediaKind;
  /** The adapter output. Variant by kind. */
  payload: MediaPayload;
  /** Chain-side audit — IDs of the blocks written. */
  chainOutput: {
    journalBlockIndex?: number;
    caseBlockIndices: number[];
    insightBlockIndex?: number;
  };
  /** ms taken end-to-end. */
  elapsedMs: number;
  error?: string;
}
