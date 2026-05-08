/**
 * Map adapter payloads onto Memphis chains via existing tools.
 *
 * - audio       → memphis_journal (transcription text + tags)
 * - image       → memphis_journal (description) + memphis_case_append per tag
 * - video       → handled in B4 once adapter ships
 *
 * Each call is best-effort. A failed chain write is logged but does
 * not throw — the orchestrator's MediaIngestResult is the source of
 * truth for what succeeded. Chain failures show up as missing block
 * indices in the result envelope.
 */

import path from 'node:path';

import type { MediaIngestResult, MediaPayload } from './types.js';
import { LOG_LEVEL } from '../../config/env-registry.js';
import { createPinoLogger } from '../../infra/logging/pino.js';
import { runMemphisJournal } from '../../mcp/tools/journal.js';


const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

interface WriteOptions {
  surface?: string;
}

export async function writeMediaToChains(
  input: { filePath: string; payload: MediaPayload },
  options: WriteOptions = {},
): Promise<MediaIngestResult['chainOutput']> {
  const out: MediaIngestResult['chainOutput'] = { caseBlockIndices: [] };
  const surface = options.surface ?? 'media-ingest';
  const baseName = path.basename(input.filePath);

  switch (input.payload.kind) {
    case 'audio': {
      const text = input.payload.text;
      if (text.length === 0) {
        return out;
      }
      try {
        const journalResult = await runMemphisJournal({
          content: `[media:audio ${baseName}] ${text}`,
          tags: [
            'media',
            'audio',
            ...(input.payload.language ? [`lang:${input.payload.language}`] : []),
          ],
          surface,
        });
        if (journalResult.success && typeof journalResult.index === 'number') {
          out.journalBlockIndex = journalResult.index;
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'media chain-output audio: journal write failed',
        );
      }
      break;
    }

    case 'image': {
      const description = input.payload.description;
      if (description.length === 0) {
        return out;
      }
      try {
        const journalResult = await runMemphisJournal({
          content: `[media:image ${baseName}] ${description}`,
          tags: ['media', 'image', ...input.payload.tags.slice(0, 8)],
          surface,
        });
        if (journalResult.success && typeof journalResult.index === 'number') {
          out.journalBlockIndex = journalResult.index;
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'media chain-output image: journal write failed',
        );
      }
      // Cases-chain seeding from tags is intentionally deferred —
      // memphis_case_append's input shape demands actor/target/etc.
      // case-graph fields, which we'd need to map from free-form
      // tags. A heuristic mapping ships in B4 alongside the video
      // adapter (which produces richer entity data). For B3 we
      // leave caseBlockIndices empty.
      break;
    }

    case 'video':
      // Stub — video adapter is B4. Orchestrator returns its own
      // error before this branch is reached.
      break;
  }

  return out;
}
