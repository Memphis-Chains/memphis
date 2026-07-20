function normalizeOperatorProbe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isTelegramToolsProbe(text: string): boolean {
  const normalized = normalizeOperatorProbe(text);
  return /^(tools?|tool list|show tools|list tools|what tools|which tools|capabilities|what can you do|co potrafisz|jakie narzedzia|jakie narzędzia)\??$/u.test(
    normalized,
  );
}

export function isTelegramModelProbe(text: string): boolean {
  const normalized = normalizeOperatorProbe(text);
  return /^(model|model\?|what model|which model|what model do you use|what model do u use|provider|provider\?|route|route\?|jaki model|jakiego modelu|context window|context tokens|context status|ile tokenów|ile tokenow|ile masz kontekstu|ile masz okna kontekstowego|okno kontekstowe|status kontekstu)\??$/u.test(
    normalized,
  );
}

export function isTelegramStatusProbe(text: string): boolean {
  const normalized = normalizeOperatorProbe(text);
  return /^(status|status\?|runtime status|system status|stan|stan systemu)\??$/u.test(normalized);
}
