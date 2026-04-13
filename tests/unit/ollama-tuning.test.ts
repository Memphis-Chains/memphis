import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OllamaProvider, resolveOllamaOptions } from '../../src/providers/index.js';

describe('resolveOllamaOptions', () => {
  it('applies offline-friendly defaults when nothing is configured', () => {
    const out = resolveOllamaOptions(undefined, {});
    expect(out.temperature).toBe(0.2);
    expect(out.num_predict).toBe(4096);
    expect(out.top_p).toBe(0.85);
    expect(out.repeat_penalty).toBe(1.15);
    expect(out.num_ctx).toBe(8192);
    // top_k is optional — unset by default.
    expect(out.top_k).toBeUndefined();
  });

  it('reads env overrides', () => {
    const out = resolveOllamaOptions(undefined, {
      OLLAMA_TEMPERATURE: '0.5',
      OLLAMA_NUM_CTX: '16384',
      OLLAMA_TOP_P: '0.9',
      OLLAMA_TOP_K: '64',
      OLLAMA_REPEAT_PENALTY: '1.2',
      OLLAMA_NUM_PREDICT_OFFLINE: '8192',
    });
    expect(out.temperature).toBe(0.5);
    expect(out.num_ctx).toBe(16384);
    expect(out.top_p).toBe(0.9);
    expect(out.top_k).toBe(64);
    expect(out.repeat_penalty).toBe(1.2);
    expect(out.num_predict).toBe(8192);
  });

  it('ChatOptions override env (explicit > env > default)', () => {
    const out = resolveOllamaOptions(
      {
        temperature: 0.1,
        maxTokens: 2048,
        topP: 0.7,
        topK: 20,
        repeatPenalty: 1.05,
        numCtx: 4096,
      },
      {
        OLLAMA_TEMPERATURE: '0.9',
        OLLAMA_NUM_CTX: '32000',
      },
    );
    expect(out.temperature).toBe(0.1);
    expect(out.num_predict).toBe(2048);
    expect(out.top_p).toBe(0.7);
    expect(out.top_k).toBe(20);
    expect(out.repeat_penalty).toBe(1.05);
    expect(out.num_ctx).toBe(4096);
  });

  it('ignores non-numeric env values (falls back to default)', () => {
    const out = resolveOllamaOptions(undefined, {
      OLLAMA_TEMPERATURE: 'not-a-number',
    });
    expect(out.temperature).toBe(0.2);
  });
});

describe('OllamaProvider.chat plumbs tuning into request body', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: 'hi' }, eval_count: 1, prompt_eval_count: 1 }),
    })) as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes num_ctx/top_p/top_k/repeat_penalty/num_predict/temperature in options', async () => {
    const provider = new OllamaProvider({
      url: 'http://127.0.0.1:11434',
      model: 'test-model',
      rawEnv: {
        OLLAMA_NUM_CTX: '8192',
        OLLAMA_TOP_P: '0.85',
        OLLAMA_TOP_K: '40',
        OLLAMA_REPEAT_PENALTY: '1.15',
        OLLAMA_TEMPERATURE: '0.2',
        OLLAMA_NUM_PREDICT_OFFLINE: '4096',
      },
    });

    await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.options).toMatchObject({
      num_ctx: 8192,
      top_p: 0.85,
      top_k: 40,
      repeat_penalty: 1.15,
      temperature: 0.2,
      num_predict: 4096,
    });
  });

  it('uses OLLAMA_REQUEST_TIMEOUT_MS for the abort signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const provider = new OllamaProvider({
      url: 'http://127.0.0.1:11434',
      model: 'm',
      rawEnv: { OLLAMA_REQUEST_TIMEOUT_MS: '120000' },
    });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(timeoutSpy).toHaveBeenCalledWith(120000);
    timeoutSpy.mockRestore();
  });
});
