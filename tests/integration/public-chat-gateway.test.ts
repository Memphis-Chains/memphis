import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPublicChatServer } from '../../scripts/public-chat-gateway.mjs';

describe('public chat', () => {
  let server: ReturnType<typeof createPublicChatServer>;
  let base: string;
  const request = vi.fn<typeof fetch>();
  const answer = () => Response.json({ done: true, message: { content: 'Dzień dobry' } });

  beforeEach(async () => {
    request.mockReset().mockImplementation(async () => answer());
    server = createPublicChatServer({ request });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const post = (body: unknown) => fetch(base + '/chat/api.php', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('sends only this conversation to the fixed local model and serves the same form locally', async () => {
    const page = await fetch(base + '/chat/').then(r => r.text());
    expect(page).toContain('lang="pl"');
    const history = [{ role: 'user', content: 'Cześć' }, { role: 'assistant', content: 'Witaj' }];
    const r = await post({ message: 'Dzień dobry', history });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.reply).toBe('Dzień dobry');
    const [url, settings] = request.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    const payload = JSON.parse(String(settings?.body));
    expect(Object.keys(payload).sort()).toEqual(['keep_alive', 'messages', 'model', 'options', 'stream']);
    expect(payload.messages).toEqual([{ role: 'system', content: expect.any(String) }, ...history, { role: 'user', content: 'Dzień dobry' }]);
    await post({ message: 'Nowa rozmowa', sessionId: result.sessionId });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).messages).toHaveLength(2);
  });

  it('rejects invalid history and oversized bodies before inference', async () => {
    expect((await post({ message: 'Dzień dobry', history: [{ role: 'user', content: 'tylko pół wymiany' }] })).status).toBe(400);
    expect((await post({ message: 'a'.repeat(50 * 1024) })).status).toBe(413);
    expect(request).not.toHaveBeenCalled();
  });

  it('reports a missing model and rejects replies with only a reasoning block', async () => {
    request.mockResolvedValueOnce(Response.json({ models: [] }));
    expect((await fetch(base + '/healthz')).status).toBe(503);
    request.mockResolvedValueOnce(Response.json({ done: true, message: { content: '<think>robocze</think>' } }));
    expect(await (await post({ message: 'Hej' })).json()).toEqual({ ok: false, error: 'backend_unavailable' });
  });

  it('limits simultaneous work and releases the slot after the provider finishes', async () => {
    let resolve!: (r: Response) => void;
    const called = new Promise<void>(notify => {
      request.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; notify(); }));
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

  it('enforces the hourly limit at the server', async () => {
    for (let i = 0; i < 10; i++) expect((await post({ message: 'Cześć' })).status).toBe(200);
    const limit = await post({ message: 'Cześć' });
    expect(limit.status).toBe(429);
    expect(Number(limit.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(10);
  });
});
