import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { readVaultSecretByKey } = vi.hoisted(() => ({ readVaultSecretByKey: vi.fn() }));

vi.mock('../../src/security/vault-boundary.js', () => ({ readVaultSecretByKey }));

import { runMemphisMiniMaxH3 } from '../../src/mcp/tools/minimax-h3.js';

describe('runMemphisMiniMaxH3', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('submits a text-to-video task to the H3 v2 endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ task_id: 'h3-task-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: 'video-payg-key' });

    const output = await runMemphisMiniMaxH3(
      { action: 'create', prompt: 'A hummingbird flies through a sunlit forest.', duration: 5 },
      { MINIMAX_VIDEO_VAULT_KEY: 'minimax_video_api_key' },
    );

    expect(output).toMatchObject({ ok: true, action: 'create', task_id: 'h3-task-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimax.io/v2/video_generation',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: 'A hummingbird flies through a sunlit forest.' }],
      resolution: '2K',
      duration: 5,
    });
  });

  it('queries an H3 task and returns its generated URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'success', content: { url: 'https://example.test/video.mp4' } }),
        {
          status: 200,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: 'video-payg-key' });

    const output = await runMemphisMiniMaxH3(
      { action: 'query', task_id: 'h3-task-1' },
      { MINIMAX_VIDEO_VAULT_KEY: 'minimax_video_api_key' },
    );

    expect(output).toMatchObject({
      ok: true,
      action: 'query',
      task_id: 'h3-task-1',
      status: 'success',
      url: 'https://example.test/video.mp4',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimax.io/v2/query/video_generation/h3-task-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });
  const secret = 'synthetic-h3-private-credential-sentinel';
  const env = { MINIMAX_VIDEO_VAULT_KEY: 'synthetic_video_reference' };
  it.each([new Error(secret, { cause: new Error('nested-' + secret) }), secret])(
    'returns a fixed failure for an opaque network exception',
    async (error) => {
      readVaultSecretByKey.mockReturnValue({ found: true, plaintext: secret });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
      const result = await runMemphisMiniMaxH3({ action: 'query', task_id: 'task-1' }, env);
      expect(result).toEqual({ ok: false, action: 'query', error: 'MINIMAX_H3_REQUEST_FAILED' });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it('keeps provider error bodies out of the tool result', async () => {
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: secret });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: secret }), { status: 401 })),
    );
    const result = await runMemphisMiniMaxH3({ action: 'query', task_id: 'task-1' }, env);
    expect(result).toEqual({ ok: false, action: 'query', error: 'MINIMAX_H3_HTTP_401' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('projects successful provider metadata without arbitrary nested data', async () => {
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: secret });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: 'task-1',
          status: 'success',
          content: { url: 'https://example.test/video.mp4', authorization: secret },
          debug: { headers: { authorization: secret }, cause: { token: secret } },
          token: secret,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await runMemphisMiniMaxH3({ action: 'query', task_id: 'task-1' }, env);
    expect(result).toEqual({
      ok: true,
      action: 'query',
      task_id: 'task-1',
      status: 'success',
      url: 'https://example.test/video.mp4',
      data: {
        task_id: 'task-1',
        status: 'success',
        content: { url: 'https://example.test/video.mp4' },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.minimax.io/v2/query/video_generation/task-1',
      expect.objectContaining({
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      }),
    );
  });

  it.each([
    ['task_id', secret],
    ['status', createHash('sha256').update(secret).digest('hex')],
    ['status', Buffer.from(secret).toString('base64')],
    ['status', Buffer.from(secret).toString('hex')],
    ['status', secret.slice(0, 16)],
    ['status', secret.slice(-16)],
    ['url', 'https://example.test/video?api_key=' + encodeURIComponent(secret)],
    ['url', 'https://user:password@example.test/video.mp4'],
    ['url', 'javascript:alert(1)'],
  ])('rejects unsafe allowed metadata in %s', async (field, value) => {
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: secret });
    const payload =
      field === 'url'
        ? { task_id: 'task-1', content: { url: value } }
        : { task_id: 'task-1', [field]: value };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    const result = await runMemphisMiniMaxH3({ action: 'query', task_id: 'task-1' }, env);
    expect(result).toEqual({ ok: false, action: 'query', error: 'MINIMAX_H3_INVALID_RESPONSE' });
  });

  it('keeps abort exception details private', async () => {
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: secret });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException(secret, 'AbortError')));
    const result = await runMemphisMiniMaxH3({ action: 'query', task_id: 'task-1' }, env);
    expect(result).toEqual({ ok: false, action: 'query', error: 'MINIMAX_H3_TIMEOUT' });
  });

  it('does not make a request without a dedicated video credential', async () => {
    readVaultSecretByKey.mockReturnValue({ found: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await runMemphisMiniMaxH3(
      { action: 'query', task_id: 'task-1' },
      { ...env, MINIMAX_API_KEY: secret },
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each([
    'null',
    '[{"task_id":"task-1"}]',
    '{"error":"synthetic-h3-private-credential-sentinel"',
  ])('does not expose an invalid JSON/root response', async (body) => {
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: secret });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const result = await runMemphisMiniMaxH3({ action: 'query', task_id: 'task-1' }, env);
    expect(result).toEqual({ ok: false, action: 'query', error: 'MINIMAX_H3_INVALID_RESPONSE' });
  });

  it('aborts a pending request at the configured deadline without exception text', async () => {
    vi.useFakeTimers();
    readVaultSecretByKey.mockReturnValue({ found: true, plaintext: secret });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          (_url: string, options: RequestInit) =>
            new Promise((_resolve, reject) =>
              options.signal?.addEventListener(
                'abort',
                () => reject(new DOMException(secret, 'AbortError')),
                { once: true },
              ),
            ),
        ),
    );
    const pending = runMemphisMiniMaxH3(
      { action: 'query', task_id: 'task-1' },
      { ...env, MINIMAX_H3_REQUEST_TIMEOUT_MS: '8' },
    );
    await vi.advanceTimersByTimeAsync(8);
    expect(await pending).toEqual({ ok: false, action: 'query', error: 'MINIMAX_H3_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
