import type { Bot } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { buildTelegramTierEnvOverride } from './telegram-tier-policy.js';
import { getTelegramSessionTier } from './telegram-tier-session.js';
import type { MessageHandler } from '../chat-types.js';
import { ingestMedia } from '../media/orchestrator.js';

export function registerTelegramMediaHandlers(
  bot: Bot,
  token: string,
  handler: MessageHandler,
): void {
  // Photo handler — runs B3 vision pipeline server-side and
  // injects the description into the bot's text brief. Server-side
  // (not "let the bot call memphis_media_ingest") because the tool
  // is tier-2-gated and the chat surface defaults to tier 2 — but
  // also because deterministic ingest avoids the bot deciding not
  // to look at the image. The honest-fallback brief from Sprint 3.1
  // still kicks in if vision fails (no Ollama vision model, network
  // hiccup, etc.) — the runtime never lies about its capabilities.
  bot.on('message:photo', async (ctx) => {
    const msg = ctx.message;
    if (!msg.photo || msg.from?.is_bot) return;

    const allowedIds = parseTelegramAllowedUserIds(process.env);
    const fromId = msg.from?.id;
    if (allowedIds.length > 0 && (fromId === undefined || !allowedIds.includes(String(fromId)))) {
      await ctx.reply('Access denied.');
      return;
    }

    const largest = msg.photo[msg.photo.length - 1];
    const caption = msg.caption?.trim() ?? '';
    const fileId = largest.file_id;

    const chatId = String(msg.chat.id);
    const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
    const sessionTier = getTelegramSessionTier(chatId);

    const captionFragment = caption.length > 0 ? `caption: "${caption}"` : 'no caption';

    let visionDescription = '';
    let visionError = '';
    let ocrText = '';
    let ocrConfidence = 0;
    let persistedPath = '';
    try {
      const file = await ctx.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const photoResponse = await fetch(fileUrl);
      if (!photoResponse.ok) {
        throw new Error(`Telegram file download failed: ${photoResponse.status}`);
      }
      const photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const { getDataDir } = await import('../../config/paths.js');
      const ext = (file.file_path?.match(/\.[a-z0-9]+$/i)?.[0] ?? '.jpg').toLowerCase();
      // REV2 Temat 1 (2026-05-12): persist photo under
      // `<data>/state/telegram-attachments/` instead of /tmp +
      // unlink. The previous pattern left the agent's next turn
      // with no path to the file — operator's "describe this
      // image" loops failed because the file was already gone and
      // `memphis_exec` couldn't see it anyway. The new path is
      // operator-readable, agent-accessible via memphis_glob (see
      // `allowedExtraRoots` in tools/glob.ts), and survives the
      // turn. A retention cron prunes >7d-old files separately.
      const attachmentsDir = path.join(getDataDir(process.env), 'state', 'telegram-attachments');
      await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
      persistedPath = path.join(attachmentsDir, `tg-photo-${msg.message_id}-${Date.now()}${ext}`);
      await fs.writeFile(persistedPath, photoBuffer);
      const result = await ingestMedia(
        persistedPath,
        { kind: 'image', surface: 'telegram' },
        process.env,
      );
      if (result.error) {
        visionError = result.error;
      } else if (result.payload.kind === 'image') {
        visionDescription = result.payload.description;
        ocrText = result.payload.ocrText ?? '';
        ocrConfidence = result.payload.ocrConfidence ?? 0;
      }
    } catch (err) {
      visionError = err instanceof Error ? err.message : String(err);
    }
    // NOTE: no unlink — file persists so the agent can re-process
    // via memphis_exec / memphis_glob on the next turn(s). Cron
    // prunes attachments older than 7 days.

    // Sprint ζ: include OCR text when Tesseract returned non-empty
    // with reasonable confidence. < 0.5 confidence text usually
    // means the image had little/no real writing — quote it but
    // mark it low-confidence so the bot doesn't over-anchor.
    const ocrLine =
      ocrText.length > 0
        ? `\n[OCR-extracted text via Tesseract, confidence ${(ocrConfidence * 100).toFixed(0)}%]\n"${ocrText.slice(0, 1500)}"`
        : '';
    // REV2 Temat 1 (2026-05-12): expose the persistent attachment
    // path so the agent can re-process via memphis_glob /
    // memphis_exec / future memphis_media_ingest retries when
    // vision degraded. Earlier code unlinked the temp file then
    // told the agent "Telegram nie zapisuje lokalnie" — both
    // lies. Path is allowlisted in tools/glob.ts.
    const pathLine = persistedPath ? `\n[attachment_path] ${persistedPath}` : '';
    const baseHeader = `[Telegram attachment: photo (${captionFragment}, width=${largest.width ?? '?'}, height=${largest.height ?? '?'}, file_id=${fileId})]${pathLine}`;
    const attachmentBrief = visionDescription
      ? `${baseHeader} Vision pipeline already described the image: "${visionDescription}".${ocrLine} ` +
        `Use the description AND the OCR text as ground truth — both were produced by the runtime before this turn. Do not claim you ran any tool.`
      : `${baseHeader} Vision pipeline error (${visionError || 'unknown'}).${ocrLine} ` +
        `Acknowledge the attachment honestly, ask the user what they'd like described, do not invent image contents.`;

    try {
      await handler({
        id: String(msg.message_id),
        channel: 'telegram',
        userId,
        chatId,
        text: attachmentBrief,
        timestamp: new Date(msg.date * 1000),
        rawEnvOverride: buildTelegramTierEnvOverride(chatId, sessionTier),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Błąd obsługi zdjęcia: ${errMsg.slice(0, 200)}`);
    }
  });

  // Document attachments — PDFs / text files / structured data.
  // Operator forwards a faktura, an article, or a log dump and
  // expects Memphis to read it. PDFs go through pdftotext (poppler
  // — Memphis-compatible Apache-license native tool already on the
  // typical install), plain text / markdown / json / csv read raw,
  // images uploaded as documents (some clients route screenshots
  // this way) reuse the existing vision pipeline so the user
  // experience is identical regardless of how the photo arrived.
  // Anything else is acknowledged honestly without invented contents.
  bot.on('message:document', async (ctx) => {
    const msg = ctx.message;
    if (!msg.document || msg.from?.is_bot) return;

    const allowedIds = parseTelegramAllowedUserIds(process.env);
    const fromId = msg.from?.id;
    if (allowedIds.length > 0 && (fromId === undefined || !allowedIds.includes(String(fromId)))) {
      await ctx.reply('Access denied.');
      return;
    }

    const doc = msg.document;
    const mime = (doc.mime_type ?? '').toLowerCase();
    const filename = doc.file_name ?? `attachment-${msg.message_id}`;
    const caption = msg.caption?.trim() ?? '';
    const captionFragment = caption.length > 0 ? `caption: "${caption}"` : 'no caption';
    const sizeBytes = doc.file_size ?? 0;
    const chatId = String(msg.chat.id);
    const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
    const sessionTier = getTelegramSessionTier(chatId);

    // Hard ceiling — Telegram lets bots fetch up to ~20 MB; refuse
    // anything bigger before paying the download cost. 10 MB chosen
    // as a practical limit (huge PDFs are rarely the operator's
    // intent and would blow up the prompt token budget anyway).
    const SIZE_LIMIT = 10 * 1024 * 1024;
    if (sizeBytes > SIZE_LIMIT) {
      await ctx.reply(
        `Plik za duży (${(sizeBytes / 1024 / 1024).toFixed(1)} MB > 10 MB). ` +
          'Wyślij krótszy fragment albo wgraj go bezpośrednio do ~/memphis/data/.',
      );
      return;
    }

    await ctx.replyWithChatAction('typing');

    let extractedText = '';
    let extractionError = '';
    let extractionMode: 'pdf' | 'text' | 'image-via-vision' | 'unsupported' = 'unsupported';
    let persistedPath = '';
    let visionDescription = '';
    let ocrText = '';
    let ocrConfidence = 0;

    try {
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        throw new Error(`Telegram file download failed: ${fileResponse.status}`);
      }
      const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const { getDataDir } = await import('../../config/paths.js');
      const ext = (filename.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
      // REV2 Temat 1 (2026-05-12): same persistence pattern as
      // the photo handler. Documents land in
      // `<data>/state/telegram-attachments/` so the agent can
      // re-read or re-extract on a follow-up turn. See photo
      // handler comment block for full rationale.
      const attachmentsDir = path.join(getDataDir(process.env), 'state', 'telegram-attachments');
      await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
      persistedPath = path.join(attachmentsDir, `tg-doc-${msg.message_id}-${Date.now()}${ext}`);
      await fs.writeFile(persistedPath, fileBuffer);

      const isPdf = mime === 'application/pdf' || ext === '.pdf';
      const isImage =
        mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
      const isPlainText =
        mime.startsWith('text/') ||
        ['.txt', '.md', '.json', '.csv', '.log', '.yaml', '.yml', '.toml', '.xml', '.tsv'].includes(
          ext,
        );

      if (isPdf) {
        extractionMode = 'pdf';
        const { spawn } = await import('node:child_process');
        extractedText = await new Promise<string>((resolve, reject) => {
          const child = spawn('pdftotext', ['-layout', '-q', '-enc', 'UTF-8', persistedPath, '-']);
          const chunks: Buffer[] = [];
          let stderr = '';
          child.stdout.on('data', (c: Buffer) => chunks.push(c));
          child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
          child.on('error', (err) => reject(err));
          child.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`pdftotext exit=${code}: ${stderr.slice(0, 200)}`));
              return;
            }
            resolve(Buffer.concat(chunks).toString('utf-8'));
          });
        });
      } else if (isPlainText) {
        extractionMode = 'text';
        // Cap raw read at 256 KB — beyond that the prompt budget
        // breaks even with truncation downstream.
        const TEXT_CAP = 256 * 1024;
        extractedText = fileBuffer.subarray(0, TEXT_CAP).toString('utf-8');
        if (fileBuffer.length > TEXT_CAP) {
          extractedText += `\n\n[…truncated; original ${(fileBuffer.length / 1024).toFixed(1)} KB, showing first 256 KB]`;
        }
      } else if (isImage) {
        extractionMode = 'image-via-vision';
        const result = await ingestMedia(
          persistedPath,
          { kind: 'image', surface: 'telegram' },
          process.env,
        );
        if (result.error) {
          extractionError = result.error;
        } else if (result.payload.kind === 'image') {
          visionDescription = result.payload.description;
          ocrText = result.payload.ocrText ?? '';
          ocrConfidence = result.payload.ocrConfidence ?? 0;
        }
      } else {
        extractionMode = 'unsupported';
        extractionError = `mime=${mime || 'unknown'} ext=${ext || 'none'}`;
      }
    } catch (err) {
      extractionError = err instanceof Error ? err.message : String(err);
    }
    // NOTE: no unlink — file persists so the agent can re-process
    // via memphis_exec / memphis_glob on the next turn(s). Cron
    // prunes attachments older than 7 days.

    // Build the LLM-facing attachment brief. Mirrors the photo
    // handler's anti-hallucination guardrail: stamp WHO did the
    // extraction (poppler / tesseract / vision LLM) and tell the
    // model to use it as ground truth, not invent contents.
    // REV2 Temat 1 (2026-05-12): expose the persistent path so
    // memphis_glob / memphis_exec can re-read this document
    // (operator may ask "what was on page 3" later in the convo).
    const pathLine = persistedPath ? `\n[attachment_path] ${persistedPath}` : '';
    const baseHeader =
      `[Telegram attachment: document filename="${filename}" mime="${mime || 'unknown'}" ` +
      `size=${sizeBytes}b ${captionFragment}]${pathLine}`;

    let attachmentBrief: string;
    if (extractionMode === 'pdf' && extractedText.length > 0) {
      // Cap PDF text in the prompt at 12 KB — model context budget
      // is finite and most operator-forwarded PDFs are <2 pages of
      // useful content. Operator can re-send a specific page or
      // section if more is needed.
      const PDF_PROMPT_CAP = 12 * 1024;
      const body =
        extractedText.length > PDF_PROMPT_CAP
          ? extractedText.slice(0, PDF_PROMPT_CAP) +
            `\n\n[…PDF truncated at ${PDF_PROMPT_CAP} chars; original ${extractedText.length} chars total]`
          : extractedText;
      attachmentBrief =
        `${baseHeader} pdftotext extracted ${extractedText.length} chars. Treat the body below as ` +
        `ground truth from the runtime; do not claim you ran any tool yourself.\n\n` +
        `--- DOCUMENT BODY ---\n${body}\n--- END BODY ---`;
    } else if (extractionMode === 'text' && extractedText.length > 0) {
      attachmentBrief =
        `${baseHeader} Read as utf-8 text (${extractedText.length} chars). Body below.\n\n` +
        `--- DOCUMENT BODY ---\n${extractedText}\n--- END BODY ---`;
    } else if (extractionMode === 'image-via-vision' && visionDescription) {
      const ocrLine =
        ocrText.length > 0
          ? `\n[OCR-extracted text via Tesseract, confidence ${(ocrConfidence * 100).toFixed(0)}%]\n"${ocrText.slice(0, 1500)}"`
          : '';
      attachmentBrief =
        `${baseHeader} Image-as-document — vision pipeline already described: "${visionDescription}".${ocrLine} ` +
        `Use the description AND the OCR text as ground truth — both were produced by the runtime before this turn.`;
    } else {
      attachmentBrief =
        `${baseHeader} Extraction unavailable (${extractionError || 'unsupported file type'}). ` +
        `Acknowledge the attachment honestly, ask the user what they need from it, do not invent contents.`;
    }

    try {
      await handler({
        id: String(msg.message_id),
        channel: 'telegram',
        userId,
        chatId,
        text: attachmentBrief,
        timestamp: new Date(msg.date * 1000),
        rawEnvOverride: buildTelegramTierEnvOverride(chatId, sessionTier),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Błąd obsługi dokumentu: ${errMsg.slice(0, 200)}`);
    }
  });
}
