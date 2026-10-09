import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeOllamaReadiness } from '../../src/infra/runtime/ollama-readiness.js';

afterEach(() => vi.unstubAllGlobals());

function responses(...values: Array<{ status?: number; body?: unknown }>) {
  const mock = vi.fn();
  for (const value of values) {
    mock.mockResolvedValueOnce(
      new Response(JSON.stringify(value.body ?? {}), { status: value.status ?? 200 }),
    );
  }
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('Ollama generation readiness', () => {
  it.each([401, 403, 404, 500])('does not report HTTP %s as ready', async (status) => {
    responses({ status });
    expect(await probeOllamaReadiness('http://localhost:11434', 'chat:3b')).toMatchObject({
      reachable: false,
      canGenerate: false,
    });
  });

  it('rejects a tags response without a model list', async () => {
    responses({ body: { status: 'ok' } });
    expect(await probeOllamaReadiness('http://localhost:11434', 'chat:3b')).toMatchObject({
      reason: 'invalid-response',
      canGenerate: false,
    });
  });

  it('does not turn embedding availability into generation readiness', async () => {
    const mock = responses({ body: { models: [{ name: 'nomic-embed-text:latest' }] } });
    expect(await probeOllamaReadiness('http://localhost:11434', 'chat:3b')).toMatchObject({
      reachable: true,
      modelPresent: false,
      canGenerate: false,
      reason: 'model-missing',
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('rejects a configured embedding-only model', async () => {
    responses(
      { body: { models: [{ name: 'nomic-embed-text:latest' }] } },
      { body: { capabilities: ['embedding'] } },
    );
    expect(await probeOllamaReadiness('http://localhost:11434', 'nomic-embed-text')).toMatchObject({
      modelPresent: true,
      canGenerate: false,
    });
  });

  it('accepts completion capability and normalizes latest tags', async () => {
    const mock = responses(
      { body: { models: [{ name: 'chat:latest' }] } },
      { body: { capabilities: ['completion', 'tools'] } },
    );
    expect(await probeOllamaReadiness('http://localhost:11434/', 'chat')).toMatchObject({
      canGenerate: true,
      reason: 'ready',
    });
    expect(mock.mock.calls[1]?.[0]).toBe('http://localhost:11434/api/show');
    expect(mock.mock.calls[1]?.[1].body).toBe('{"model":"chat"}');
  });

  it('does not accept a different model tag', async () => {
    responses({ body: { models: [{ name: 'chat:7b' }] } });
    expect((await probeOllamaReadiness('http://localhost:11434', 'chat:3b')).canGenerate).toBe(
      false,
    );
  });

  it('treats old servers without capabilities as unverified', async () => {
    responses({ body: { models: [{ name: 'chat:3b' }] } }, { body: { model_info: {} } });
    expect((await probeOllamaReadiness('http://localhost:11434', 'chat:3b')).reason).toBe(
      'completion-unverified',
    );
  });

  it('preserves reachability when model details are refused', async () => {
    responses({ body: { models: [{ name: 'chat:3b' }] } }, { status: 404 });
    expect(await probeOllamaReadiness('http://localhost:11434', 'chat:3b')).toMatchObject({
      reachable: true,
      canGenerate: false,
    });
  });

  it('handles an unreachable daemon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    expect((await probeOllamaReadiness('http://localhost:11434', 'chat:3b')).reason).toBe(
      'unreachable',
    );
  });
});
