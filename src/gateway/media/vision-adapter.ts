/**
 * Vision adapter — sends an image to a local Ollama vision model
 * (moondream / llava / granite3.2-vision / etc) and returns a typed
 * ImageDescription.
 *
 * Local-only by design (per B1 security stance). Uses the existing
 * Ollama provider URL (OLLAMA_URL) and an env-configurable model
 * (MEMPHIS_MEDIA_VISION_MODEL, default `moondream` — small + fast,
 * good Polish operator-machine fit; ~1.6 GB on disk).
 *
 * Tag extraction is intentionally simple: parse comma-separated
 * nouns the model emits inside a TAGS: line. A B4 iteration can
 * upgrade to a structured-prompt pass if precision matters.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ImageDescription } from './types.js';
import { LOG_LEVEL, MEMPHIS_VISION_TIMEOUT_MS } from '../../config/env-registry.js';
import { createPinoLogger } from '../../infra/logging/pino.js';


const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

// Phase 1.5.3 closeout: env-driven via MEMPHIS_VISION_TIMEOUT_MS
// (default 10 min, was 90 s hardcode).
const VISION_TIMEOUT_MS = MEMPHIS_VISION_TIMEOUT_MS.read(process.env);
// Default vision model. Picked `moondream` (Ollama registry name —
// `moondream2` is the upstream version label but the pull command is
// `ollama pull moondream`). Small + fast, ~1.6 GB. Operator override
// via MEMPHIS_MEDIA_VISION_MODEL — common alternatives:
//   - llava               (7B, ~4.5 GB, higher quality)
//   - granite3.2-vision   (~2.4 GB, IBM, often pre-pulled on dev boxes)
//   - bakllava            (7B, llava+mistral fusion)
const DEFAULT_MODEL = 'moondream';
const DEFAULT_PROMPT =
  'Opisz krótko co widać na zdjęciu — obiekty, miejsca, osoby (BEZ identyfikacji konkretnych ludzi). ' +
  'Po polsku, 2-3 zdania. Następnie w nowej linii TAGS: <comma-separated-list-of-keywords>.';

interface VisionAdapterOptions {
  model?: string;
  prompt?: string;
}

/**
 * Quick PNG/JPEG header read for dimensions. Returns undefined on
 * any parse failure — dimensions are nice-to-have, not required.
 */
async function readImageDimensions(
  filePath: string,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const fd = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(32);
      await fd.read(buf, 0, 32, 0);

      // PNG: signature 89 50 4E 47 0D 0A 1A 0A, IHDR at offset 16
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        return { width, height };
      }
      // JPEG: starts with FF D8 — dimensions need full scan; skip the
      // expense, return undefined. Operator can read EXIF separately.
      return undefined;
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Split the model's reply into description + tags. Looks for a
 * "TAGS:" marker (case-insensitive). Falls back to whole-text
 * description + no tags when the model doesn't follow the format.
 */
function splitDescriptionAndTags(modelText: string): {
  description: string;
  tags: string[];
} {
  const lines = modelText.split(/\r?\n/);
  const tagsIdx = lines.findIndex((l) => /^\s*tags\s*:/i.test(l));
  if (tagsIdx === -1) {
    return { description: modelText.trim(), tags: [] };
  }
  const description = lines.slice(0, tagsIdx).join('\n').trim();
  const tagsLine = lines[tagsIdx]!.replace(/^\s*tags\s*:/i, '').trim();
  const tags = tagsLine
    .split(/[,;]/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length < 40);
  return { description, tags };
}

export async function describeImage(
  filePath: string,
  options: VisionAdapterOptions = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ImageDescription> {
  try {
    const buffer = await fs.readFile(filePath);
    const base64 = buffer.toString('base64');

    const ollamaUrl = (rawEnv.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const model = options.model ?? rawEnv.MEMPHIS_MEDIA_VISION_MODEL?.trim() ?? DEFAULT_MODEL;
    const prompt = options.prompt ?? DEFAULT_PROMPT;

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images: [base64],
        stream: false,
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, file: path.basename(filePath) },
        'media vision adapter: ollama non-OK',
      );
      return { kind: 'image', description: '', tags: [] };
    }

    const data = (await response.json()) as { response?: string };
    const modelText = (data.response ?? '').trim();
    if (modelText.length === 0) {
      return { kind: 'image', description: '', tags: [] };
    }

    const { description, tags } = splitDescriptionAndTags(modelText);
    const dimensions = await readImageDimensions(filePath);
    return { kind: 'image', description, tags, dimensions };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'media vision adapter error',
    );
    return { kind: 'image', description: '', tags: [] };
  }
}
