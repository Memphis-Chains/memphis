import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPublicChatServer } from '../../scripts/public-chat-gateway.mjs';
import {
  classifyPublicQuestion,
  publicNotesFromBlocks,
} from '../../src/infra/http/public-chain-context.js';
import { createPublicMinimaxRelay } from '../../src/infra/http/public-minimax.js';

describe('public chat', () => {
  let server: ReturnType<typeof createPublicChatServer>;
  let base: string;
  const request = vi.fn<typeof fetch>();
  const cloud = vi.fn();
  const answer = () => Response.json({ done: true, message: { content: 'Dzień dobry' } });

  beforeEach(async () => {
    request.mockReset().mockImplementation(async () => answer());
    cloud.mockReset().mockRejectedValue(new Error('offline'));
    server = createPublicChatServer({ request, minimax: cloud });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const post = (body: unknown) =>
    fetch(base + '/chat/api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sends only this conversation to the fixed local model and serves the same form locally', async () => {
    const page = await fetch(base + '/chat/').then((r) => r.text());
    expect(page).toContain('lang="pl"');
    const history = [
      { role: 'user', content: 'Cześć' },
      { role: 'assistant', content: 'Witaj' },
    ];
    const r = await post({ message: 'Dzień dobry', history });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.reply).toBe('Dzień dobry');
    const [url, settings] = request.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    const payload = JSON.parse(String(settings?.body));
    expect(Object.keys(payload).sort()).toEqual([
      'keep_alive',
      'messages',
      'model',
      'options',
      'stream',
    ]);
    expect(payload.messages).toEqual([
      { role: 'system', content: expect.any(String) },
      ...history,
      { role: 'user', content: 'Dzień dobry' },
    ]);
    await post({ message: 'Nowa rozmowa', sessionId: result.sessionId });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).messages).toHaveLength(2);
  });

  it('rejects invalid history and oversized bodies before inference', async () => {
    expect(
      (
        await post({
          message: 'Dzień dobry',
          history: [{ role: 'user', content: 'tylko pół wymiany' }],
        })
      ).status,
    ).toBe(400);
    expect((await post({ message: 'a'.repeat(50 * 1024) })).status).toBe(413);
    expect(request).not.toHaveBeenCalled();
  });

  it('reports a missing model and rejects replies with only a reasoning block', async () => {
    request.mockResolvedValueOnce(Response.json({ models: [] }));
    expect((await fetch(base + '/healthz')).status).toBe(503);
    request.mockResolvedValueOnce(
      Response.json({ done: true, message: { content: '<think>robocze</think>' } }),
    );
    expect(await (await post({ message: 'Hej' })).json()).toEqual({
      ok: false,
      error: 'backend_unavailable',
    });
  });

  it('returns the actual cloud model, falls back to Ollama on outage, and keeps local-only requests local', async () => {
    cloud.mockResolvedValueOnce({ status: 200, data: { reply: 'Dwanaście', model: 'MiniMax-M3' } });
    const online = await (await post({ message: 'Ile to 7+5?', mode: 'auto' })).json();
    expect(online).toMatchObject({
      reply: 'Dwanaście',
      meta: { provider: 'minimax', model: 'MiniMax-M3' },
    });
    expect(cloud.mock.calls[0][1]).toEqual([{ role: 'user', content: 'Ile to 7+5?' }]);
    expect(request).not.toHaveBeenCalled();
    expect(
      (await (await post({ message: 'Tylko lokalnie', mode: 'local' })).json()).meta.provider,
    ).toBe('ollama');
    expect(cloud.mock.calls.map((call) => call[0])).toEqual(['/chat', '/classify']);
    expect(
      (await (await post({ message: 'Brak internetu', mode: 'auto' })).json()).meta.provider,
    ).toBe('ollama');
    expect((await post({ message: 'Wciąż offline', mode: 'auto' })).status).toBe(200);
    expect(cloud.mock.calls.map((call) => call[0])).toEqual([
      '/chat',
      '/classify',
      '/chat',
      '/classify',
    ]);
  });

  it('honors a restricted reply without retrying another provider', async () => {
    cloud.mockResolvedValueOnce({ status: 422, data: { error: 'restricted' } });
    expect((await post({ message: 'Test odmowy', mode: 'auto' })).status).toBe(422);
    expect(request).not.toHaveBeenCalled();
  });

  it('limits simultaneous work and releases the slot after the provider finishes', async () => {
    let resolve!: (r: Response) => void;
    const called = new Promise<void>((notify) => {
      request.mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
            notify();
          }),
      );
    });
    const first = post({ message: 'Pierwsza' });
    await called;
    const busy = await post({ message: 'Druga' });
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
    resolve(answer());
    expect((await first).status).toBe(200);
    expect((await post({ message: 'Trzecia' })).status).toBe(200);
  });

  it('allows new messages when the short burst window expires', async () => {
    for (let i = 0; i < 10; i++) expect((await post({ message: 'Cześć' })).status).toBe(200);
    const limit = await post({ message: 'Cześć' });
    expect(limit.status).toBe(429);
    expect(Number(limit.headers.get('retry-after'))).toBeLessThanOrEqual(10);
    expect(request).toHaveBeenCalledTimes(10);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
    try {
      expect((await post({ message: 'Następna' })).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
});

it('the private relay pins the model and sends only the supplied conversation to the provider', async () => {
  const chat = vi
    .fn()
    .mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', content: 'Cześć' });
  const resolveProvider = vi.fn().mockReturnValue({ chat, isConfigured: () => true });
  const classification = { model: 'basal-test', route: 'general' };
  const classify = vi.fn().mockResolvedValue(classification);
  const relay = createPublicMinimaxRelay({ resolveProvider }, classify);
  try {
    const turns = [{ role: 'user', content: 'Dzień dobry' }];
    const result = await relay.inject({ method: 'POST', url: '/chat', payload: turns });
    expect(result.json()).toEqual({ reply: 'Cześć', model: 'MiniMax-M3', classification });
    expect(classify.mock.invocationCallOrder[0]).toBeLessThan(chat.mock.invocationCallOrder[0]);
    expect(resolveProvider).toHaveBeenCalledWith('minimax');
    expect(chat.mock.calls[0][0]).toEqual([
      { role: 'system', content: expect.any(String) },
      ...turns,
    ]);
    expect(chat.mock.calls[0][1]).toMatchObject({ model: 'MiniMax-M3', rejectRedirects: true });
    expect(chat.mock.calls[0][1]).not.toHaveProperty('tools');
    expect(
      (
        await relay.inject({
          method: 'POST',
          url: '/chat',
          payload: [{ role: 'assistant', content: 'Nieparzysta historia' }],
        })
      ).statusCode,
    ).toBe(400);
    expect((await relay.inject({ method: 'GET', url: '/v1/metrics' })).statusCode).toBe(404);
    classify.mockResolvedValueOnce(null);
    expect((await relay.inject({ method: 'POST', url: '/chat', payload: turns })).statusCode).toBe(
      503,
    );
    expect(chat).toHaveBeenCalledTimes(1);
  } finally {
    await relay.close();
  }
});

it('offers Basal explicitly public sources and rechecks consent before sending any excerpt', async () => {
  const block = {
    chain: 'journal',
    index: 7,
    hash: 'public-hash',
    data: { consent: 'exportable', tags: ['public-chat'], content: 'Publiczna wiedza o Memphis.' },
  };
  const restricted = { ...block, index: 8, data: { ...block.data, consent: 'local-only' } };
  const unmarked = { ...block, index: 9, data: { ...block.data, tags: [] } };
  const annotation = {
    chain: 'journal',
    index: 10,
    data: {
      kind: 'consent.annotation',
      target_chain: 'journal',
      from_index: 7,
      to_index: 7,
      level: 'local-only',
    },
  };
  const notes = publicNotesFromBlocks([block, restricted, unmarked]);
  expect(notes.map((n) => n.index)).toEqual([7]);
  expect(publicNotesFromBlocks([block, restricted, unmarked, annotation])).toEqual([]);
  const decision = vi
    .fn()
    .mockResolvedValue({ ok: true, auto: true, choice: 'yes', model: 'basal-test' });
  const read = vi.fn().mockResolvedValue(notes);
  expect((await classifyPublicQuestion('Co to Memphis?', read, decision))?.source).toEqual(
    notes[0],
  );
  expect(decision.mock.calls[0][0].state).toContain(block.data.content);
  read.mockResolvedValueOnce(notes).mockResolvedValueOnce([]);
  expect((await classifyPublicQuestion('Pytanie', read, decision))?.source).toBeUndefined();
});
