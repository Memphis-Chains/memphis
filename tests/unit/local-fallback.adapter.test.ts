import { describe, expect, it } from 'vitest';

import { LocalFallbackProvider } from '../../src/providers/local-fallback/adapter.js';

describe('LocalFallbackProvider', () => {
  it('returns deterministic fallback output shape', async () => {
    const provider = new LocalFallbackProvider();
    const result = await provider.generate({ input: 'test input' });

    expect(result.providerUsed).toBe('local-fallback');
    expect(result.modelUsed).toBe('local-fallback-v0');
    expect(result.output).toContain('test input');
    expect(result.id.startsWith('gen_')).toBe(true);
  });
});
