const TTS_MAX_SENTENCES = 6;

export function buildTelegramTtsReplyText(fullText: string): string {
  const sanitized = sanitizeTelegramTextForTts(fullText);
  const parts = sanitized.match(/[^.!?…]+[.!?…]+\s*/g) ?? [sanitized];
  if (parts.length <= TTS_MAX_SENTENCES) return sanitized.trim();
  const head = parts.slice(0, TTS_MAX_SENTENCES).join('').trim();
  return `${head} Reszta w tekście.`;
}

export function sanitizeTelegramTextForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (blok kodu) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\u{200B}|\u{200C}|\u{200D}|\u{FE0F}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
