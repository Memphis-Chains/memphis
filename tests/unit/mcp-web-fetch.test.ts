import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runMemphisWebFetch } from '../../src/mcp/tools/web-fetch.js';

describe('mcp tools — web-fetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches a public URL successfully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        text: async () => 'Hello World',
      }),
    );

    const result = await runMemphisWebFetch({ url: 'https://example.com' });
    expect(result.status).toBe(200);
    expect(result.content).toBe('Hello World');
    expect(result.truncated).toBe(false);
  });

  it('truncates responses over 4000 chars', async () => {
    const longContent = 'x'.repeat(5000);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        text: async () => longContent,
      }),
    );

    const result = await runMemphisWebFetch({ url: 'https://example.com/long' });
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(4000);
  });

  it('blocks localhost URLs (SSRF protection)', async () => {
    await expect(runMemphisWebFetch({ url: 'http://localhost:3000' })).rejects.toThrow(
      'URL blocked',
    );
  });

  it('blocks 127.0.0.1 URLs', async () => {
    await expect(runMemphisWebFetch({ url: 'http://127.0.0.1/admin' })).rejects.toThrow(
      'URL blocked',
    );
  });

  it('blocks private network 192.168.x.x', async () => {
    await expect(runMemphisWebFetch({ url: 'http://192.168.1.1' })).rejects.toThrow('URL blocked');
  });

  it('blocks private network 10.x.x.x', async () => {
    await expect(runMemphisWebFetch({ url: 'http://10.0.0.1' })).rejects.toThrow('URL blocked');
  });

  it('blocks .local domains', async () => {
    await expect(runMemphisWebFetch({ url: 'http://myserver.local' })).rejects.toThrow(
      'URL blocked',
    );
  });

  it('blocks .internal domains', async () => {
    await expect(runMemphisWebFetch({ url: 'http://api.internal' })).rejects.toThrow('URL blocked');
  });

  it('blocks non-http protocols', async () => {
    await expect(runMemphisWebFetch({ url: 'ftp://example.com/file' })).rejects.toThrow(
      'URL blocked',
    );
  });

  it('blocks URLs with overly long query strings', async () => {
    const longQuery = 'q=' + 'a'.repeat(250);
    await expect(
      runMemphisWebFetch({ url: `https://example.com?${longQuery}` }),
    ).rejects.toThrow('URL blocked');
  });

  it('blocks invalid URLs', async () => {
    await expect(runMemphisWebFetch({ url: 'not-a-url' })).rejects.toThrow('URL blocked');
  });
});
