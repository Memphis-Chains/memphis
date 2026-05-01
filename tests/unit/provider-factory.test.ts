import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAvailabilityCacheForTests,
  resolveProvider,
} from '../../src/providers/factory.js';

describe('providers/factory resolveProvider (S5-6)', () => {
  const originalEnv = { ...process.env };
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    __resetAvailabilityCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = realFetch;
    process.env = { ...originalEnv };
    __resetAvailabilityCacheForTests();
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

  it('returns null when a tagged request asks for a different tag of the same base (Codex P1 round 2)', async () => {
    // Operator scenario: requested qwen2.5:0.5b but only qwen2.5:1.5b
    // installed. Loose base-match would treat them as equivalent and
    // the chat call would later fail on the missing exact tag — cascade
    // stays broken. Tagged requests require exact tag match.
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }] }), { status: 200 }),
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

  it('bounds listModels probe at 3s when /api/tags hangs (Codex P1 round 4)', { timeout: 6000 }, async () => {
    // OllamaProvider.listModels uses bare fetch with no timeout. A
    // hung daemon would otherwise block resolveProvider indefinitely.
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    let probeCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      probeCount += 1;
      if (probeCount === 1) {
        // isAvailable probe — succeeds.
        return Promise.resolve(
          new Response(JSON.stringify({ models: [{ name: 'qwen2.5:0.5b' }] }), { status: 200 }),
        );
      }
      // listModels probe — never resolves (simulates hung daemon).
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    const start = Date.now();
    const resolved = await resolveProvider({ provider: 'ollama', model: 'qwen2.5:0.5b' });
    const elapsed = Date.now() - start;
    // Timeout treats listModels as empty → resolveProvider returns null
    // (model considered missing).
    expect(resolved).toBeNull();
    // Wall-time bounded at ~3s, not unbounded.
    expect(elapsed).toBeLessThan(4000);
    expect(elapsed).toBeGreaterThanOrEqual(2900);
  });

  it('caches isAvailable so cascading calls do not pay 3× the timeout when Ollama is down (Codex P1 round 3)', async () => {
    // Categorizer cascades resolveProvider three times (qwen2.5:0.5b →
    // phi3 → default). Each isAvailable() probe has a 3s timeout, so
    // an offline Ollama would have cost up to 9 seconds before the
    // cache landed. With caching, the 2nd and 3rd calls return the
    // cached negative result immediately.
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    let probeCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      probeCount += 1;
      return Promise.reject(new Error('ECONNREFUSED'));
    }) as unknown as typeof fetch;

    await resolveProvider({ provider: 'ollama', model: 'qwen2.5:0.5b' });
    await resolveProvider({ provider: 'ollama', model: 'phi3' });
    await resolveProvider({ provider: 'ollama' });

    // Only one probe should have hit the network — the other two
    // resolve from cache.
    expect(probeCount).toBe(1);
  });

  it('rejects non-ollama provider hints (scope is narrow on purpose)', async () => {
    const resolved = await resolveProvider({
      provider: 'minimax' as unknown as 'ollama',
      model: 'MiniMax-M2.7',
    });
    expect(resolved).toBeNull();
  });
});
