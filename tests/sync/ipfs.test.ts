import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IPFSSync } from '../../src/sync/ipfs.js';

describe('IPFSSync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('push returns CID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ IpfsHash: 'QmCID123' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const client = new IPFSSync({ gatewayBaseUrl: 'https://pinata.test' });
    const cid = await client.push([{ index: 1, content: 'hello' }]);
    expect(cid).toBe('QmCID123');
  });

  it('pull returns blocks array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ blocks: [{ index: 1, content: 'world' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new IPFSSync({ gatewayBaseUrl: 'https://pinata.test' });
    const blocks = await client.pull('QmCID123');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('world');
  });

  it('pin issues pinByHash request', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new IPFSSync({ gatewayBaseUrl: 'https://pinata.test' });
    await client.pin('QmCID999');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pinning/pinByHash');
  });
});
