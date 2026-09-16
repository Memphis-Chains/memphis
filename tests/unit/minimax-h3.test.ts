import { afterEach, describe, expect, it, vi } from 'vitest';

const { readVaultSecretByKey } = vi.hoisted(() => ({ readVaultSecretByKey: vi.fn() }));

vi.mock('../../src/security/vault-boundary.js', () => ({ readVaultSecretByKey }));

import { runMemphisMiniMaxH3 } from '../../src/mcp/tools/minimax-h3.js';

describe('runMemphisMiniMaxH3', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('submits a text-to-video task to the H3 v2 endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ task_id: 'h3-task-1' }), { status: 200 }),
    );
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
      new Response(JSON.stringify({ status: 'success', content: { url: 'https://example.test/video.mp4' } }), {
        status: 200,
      }),
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
});
