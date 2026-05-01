import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProvider } from '../../src/providers/factory.js';

describe('providers/factory resolveProvider (S5-6)', () => {
  const originalEnv = { ...process.env };
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = realFetch;
    process.env = { ...originalEnv };
  });

  it('returns null when ollama is unreachable (silent dead-path replaced — Level A S5-6)', async () => {
    // Prior to S5-6 the function returned null unconditionally. This
    // test pins the unreachable-ollama outcome so a future regression
    // back to "always null" is caught explicitly.
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const resolved = await resolveProvider({ provider: 'ollama', model: 'qwen2.5:0.5b' });
    expect(resolved).toBeNull();
  });

  it('returns a real provider with chat() when ollama is reachable', async () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    // First fetch: provider.isAvailable() (HEAD or GET to /api/tags).
    // Second fetch: chat() POST to /api/chat.
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        // isAvailable probe.
        return Promise.resolve(new Response('{"models":[]}', { status: 200 }));
      }
      // chat() response — Ollama format.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'qwen2.5:0.5b',
            message: { role: 'assistant', content: '[{"tag":"feature","confidence":0.9}]' },
            done: true,
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    const resolved = await resolveProvider({ provider: 'ollama', model: 'qwen2.5:0.5b' });
    expect(resolved).not.toBeNull();
    expect(resolved?.model).toBe('qwen2.5:0.5b');
    const reply = await resolved!.provider.chat([{ role: 'user', content: 'classify' }], {
      model: 'qwen2.5:0.5b',
    });
    expect(reply.content).toContain('feature');
  });

  it('rejects non-ollama provider hints (scope is narrow on purpose)', async () => {
    const resolved = await resolveProvider({
      provider: 'minimax' as unknown as 'ollama',
      model: 'MiniMax-M2.7',
    });
    expect(resolved).toBeNull();
  });
});
