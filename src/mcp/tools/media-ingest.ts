/**
 * memphis_media_ingest — MCP tool wrapping the gateway media pipeline.
 *
 * Per B2 spec — thin handler that delegates to ingestMedia(). Tier 2
 * (network read for Ollama vision + filesystem read of the input
 * file). The tool is feature-flagged behind MEMPHIS_MEDIA_ENABLED so
 * operators with no Ollama vision model pulled don't accidentally
 * call it.
 */

import {
  ingestMedia,
  type IngestMediaOptions,
} from '../../gateway/media/orchestrator.js';
import type { MediaIngestResult, MediaKind } from '../../gateway/media/types.js';

export interface MemphisMediaIngestInput {
  /** Absolute path to the media file. */
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
): Promise<MemphisMediaIngestOutput> {
  const options: IngestMediaOptions = {
    kind: input.type,
    dryRun: input.dryRun,
    surface: 'media-ingest',
  };
  return ingestMedia(input.path, options, rawEnv);
}
