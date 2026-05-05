/**
 * OCR adapter — wraps the Tesseract CLI to extract text from images.
 *
 * Sprint ζ rationale: the local vision LLM (moondream on this hardware)
 * describes scenes / objects / faces well but cannot read Polish text in
 * screenshots. Operator session 2026-05-05 hit "ids dla, dlac, dlac"
 * gibberish for a screenshot the operator sent. Granite/llava OOM on
 * Maxwell GPU, so heavier vision models aren't a path here.
 *
 * Tesseract is the right tool for the text-on-image case: CPU-only,
 * fast, deterministic, supports Polish (`pol` traineddata). We shell
 * out via `execFile` (no shell, args as array) so a malicious filename
 * cannot inject. Returns empty result when Tesseract is unavailable —
 * the photo handler stays useful, just without OCR.
 */

import { promises as fs } from 'node:fs';

import type { ImageDescription } from './types.js';
import { LOG_LEVEL, MEMPHIS_OCR_LANG } from '../../config/env-registry.js';
import { createPinoLogger } from '../../infra/logging/pino.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

// Tesseract on commodity CPUs (Sandy-Bridge i3-2120 measured 2m44s on
// a 1680×1050 screenshot) is slow. Telegram down-scales attached
// photos to ~1280px max before delivery, so typical bot inputs finish
// in 30-60s. Cap at 90s so a single big screenshot doesn't block the
// reply forever — the vision LLM (parallel) ships the description
// without OCR if Tesseract hits the cap.
const OCR_TIMEOUT_MS = 90_000;
const DEFAULT_LANG = 'pol+eng';

export interface OcrResult {
  /** Concatenated recognised text — already trimmed. Empty if nothing
   *  was extracted (image with no text, or Tesseract failed). */
  text: string;
  /** Mean Tesseract confidence across recognised words, 0..1. */
  confidence: number;
  /** Set when the adapter could not run (binary missing / timed out /
   *  unrecognised stderr). The caller should treat this like an empty
   *  result — never fabricate the text in this case. */
  error?: string;
}

/**
 * Probe whether the `tesseract` binary is reachable. Cached per process
 * — the binary doesn't appear or disappear at runtime.
 */
let cachedAvailability: boolean | undefined;
export async function tesseractAvailable(): Promise<boolean> {
  if (cachedAvailability !== undefined) return cachedAvailability;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('tesseract', ['--version'], { timeout: 3000 });
    cachedAvailability = true;
  } catch {
    cachedAvailability = false;
  }
  return cachedAvailability;
}

/**
 * Run Tesseract on an image and return text + mean confidence.
 *
 * Implementation note: we use `tesseract <input> stdout` for the text
 * pass, then a second `tesseract <input> stdout tsv` pass for the
 * confidence score. Two passes are cheap on CPU (typical screenshot
 * runs in <2s) and avoid parsing the more brittle hOCR XML. The TSV
 * format has a stable header line + per-word rows we can parse with
 * a simple splitter.
 */
export async function extractTextFromImage(
  filePath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<OcrResult> {
  if (!(await tesseractAvailable())) {
    return {
      text: '',
      confidence: 0,
      error:
        'tesseract binary not available — install tesseract-ocr + tesseract-ocr-pol to enable OCR for image attachments',
    };
  }

  // Validate the file exists; Tesseract's error on missing input is a
  // generic "Read error" that's harder to disambiguate from real OCR
  // failure modes.
  try {
    await fs.access(filePath);
  } catch (err) {
    return {
      text: '',
      confidence: 0,
      error: `image file unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const lang = MEMPHIS_OCR_LANG.read(rawEnv) || DEFAULT_LANG;

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Pass 1 — plain text
    // --oem 1 = LSTM-only engine. Default (--oem 3) runs both LSTM
    // and the legacy engine, which roughly doubles the wall-clock
    // for a marginal accuracy gain. LSTM-only is the right pick on
    // CPU-bound boxes.
    const textRun = await execFileAsync(
      'tesseract',
      [filePath, 'stdout', '-l', lang, '--oem', '1'],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const text = textRun.stdout.trim();

    // Pass 2 — TSV for confidence. Each word row carries `conf` in
    // column index 10 (0-based) per the documented Tesseract TSV
    // format. Skip the header row and the layout rows (level < 5).
    const tsvRun = await execFileAsync(
      'tesseract',
      [filePath, 'stdout', '-l', lang, '--oem', '1', 'tsv'],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const confidences: number[] = [];
    const lines = tsvRun.stdout.split('\n');
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length < 12) continue;
      const level = Number(cols[0]);
      if (level !== 5) continue; // 5 = word-level
      const conf = Number(cols[10]);
      if (!Number.isFinite(conf) || conf < 0) continue;
      confidences.push(conf);
    }
    const meanConf =
      confidences.length === 0
        ? 0
        : confidences.reduce((a, b) => a + b, 0) / confidences.length / 100;

    log.debug({ chars: text.length, words: confidences.length, meanConf }, 'tesseract OCR success');
    return { text, confidence: meanConf };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'tesseract OCR failed');
    return { text: '', confidence: 0, error: `tesseract failed: ${msg.slice(0, 200)}` };
  }
}

/**
 * Convenience: enrich an existing ImageDescription with OCR fields.
 * Returns the same object reference for chaining.
 */
export async function enrichImageWithOcr(
  description: ImageDescription,
  filePath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ImageDescription> {
  const ocr = await extractTextFromImage(filePath, rawEnv);
  if (!ocr.error) {
    description.ocrText = ocr.text;
    description.ocrConfidence = ocr.confidence;
  }
  return description;
}
