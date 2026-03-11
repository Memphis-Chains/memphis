import { describe, expect, it } from 'vitest';

import { generateResponseSchema } from '../../src/infra/http/contracts.js';

describe('HTTP response contracts', () => {
  it('accepts valid generate response', () => {
    const parsed = generateResponseSchema.safeParse({
      id: 'gen_1',
      providerUsed: 'local-fallback',
      modelUsed: 'local-fallback-v0',
      output: 'hi',
      usage: { inputTokens: 1, outputTokens: 1 },
      timingMs: 1,
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects invalid generate response', () => {
    const parsed = generateResponseSchema.safeParse({
      id: '',
      providerUsed: 'local-fallback',
      output: '',
      timingMs: -1,
    });

    expect(parsed.success).toBe(false);
  });
});
