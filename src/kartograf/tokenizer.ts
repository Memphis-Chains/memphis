import type { PreTrainedTokenizer } from '@huggingface/transformers';

import { KARTOGRAF_MAX_TOKENS } from './embedding-space.js';

/** Match Python tokenizers: truncate content BEFORE adding CLS/SEP tokens. */
export function kartografTokenIds(tokenizer: PreTrainedTokenizer, text: string): number[] {
  const process = (tokens: string[]) =>
    tokenizer.post_processor
      ? tokenizer.post_processor.post_process(tokens, null, { add_special_tokens: true }).tokens
      : tokens;
  const reserved = process([]).length;
  if (reserved >= KARTOGRAF_MAX_TOKENS) throw new Error('Invalid tokenizer special-token budget');
  const content = tokenizer.tokenize(text, { add_special_tokens: false });
  const tokens = process(content.slice(0, KARTOGRAF_MAX_TOKENS - reserved));
  const ids = tokenizer.model.convert_tokens_to_ids(tokens);
  if (!ids.length || ids.length > KARTOGRAF_MAX_TOKENS || !ids.every(Number.isSafeInteger))
    throw new Error('Invalid tokenizer output');
  return ids;
}
