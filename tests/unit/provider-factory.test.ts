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

  it('returns a real provider with chat() when ollama is reachable AND model is installed', async () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    // Three fetches: isAvailable probe, listModels probe, chat call.
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        // isAvailable probe (also returns the tag list — Ollama uses
        // /api/tags for both).
        return Promise.resolve(
          new Response(JSON.stringify({ models: [{ name: 'qwen2.5:0.5b' }] }), { status: 200 }),
        );
      }
      if (call === 2) {
        // listModels probe (model presence check).
        return Promise.resolve(
          new Response(JSON.stringify({ models: [{ name: 'qwen2.5:0.5b' }] }), { status: 200 }),
        );
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

  it('returns null when ollama is up but the requested model is not installed (Codex P1 round 1)', async () => {
    // Operator scenario: Ollama is running but qwen2.5:0.5b never pulled.
    // Without this check, the categorizer cascade collapses to the first
    // tier and the later chat call throws — emitting zero suggestions.
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: 'llama3:latest' }] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const resolved = await resolveProvider({ provider: 'ollama', model: 'qwen2.5:0.5b' });
    expect(resolved).toBeNull();
  });

  it('matches a bare-model hint ("phi3") against the canonical tag ("phi3:latest")', async () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      const tagsBody = JSON.stringify({ models: [{ name: 'phi3:latest' }] });
      if (call <= 2) {
        return Promise.resolve(new Response(tagsBody, { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    const resolved = await resolveProvider({ provider: 'ollama', model: 'phi3' });
    expect(resolved).not.toBeNull();
  });

  it('rejects non-ollama provider hints (scope is narrow on purpose)', async () => {
    const resolved = await resolveProvider({
      provider: 'minimax' as unknown as 'ollama',
      model: 'MiniMax-M2.7',
    });
    expect(resolved).toBeNull();
  });
});
