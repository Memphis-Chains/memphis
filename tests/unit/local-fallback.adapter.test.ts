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

  it('answers from the latest user message without echoing protected prompt text', async () => {
    const provider = new LocalFallbackProvider();
    const result = await provider.generate({
      input: 'SYSTEM: protected prompt\n\nUSER: latest question',
      messages: [
        { role: 'system', content: 'protected prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Fallback response: Hello' },
        { role: 'user', content: 'What did I just say?' },
      ],
    });

    expect(result.output).toBe('Fallback response: Hello');
    expect(result.output).not.toContain('protected prompt');
  });

  it('keeps ask-session recall deterministic with framed user input', async () => {
    const provider = new LocalFallbackProvider();
    const result = await provider.generate({
      input: 'SYSTEM: protected prompt\n\nUSER: <user_input>\nWhat did I just say?\n</user_input>',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Fallback response: Hello' },
        { role: 'user', content: '<user_input>\nWhat did I just say?\n</user_input>' },
      ],
    });

    expect(result.output).toBe('Fallback response: Hello');
    expect(result.output).not.toContain('protected prompt');
  });
});
