import { describe, expect, it } from 'vitest';

import { chatGenerateSchema } from '../../src/infra/config/request-schemas.js';

describe('chatGenerateSchema', () => {
  it('accepts minimal valid payload', () => {
    const parsed = chatGenerateSchema.safeParse({ input: 'hello' });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid payload', () => {
    const parsed = chatGenerateSchema.safeParse({ input: '' });
    expect(parsed.success).toBe(false);
  });
});
