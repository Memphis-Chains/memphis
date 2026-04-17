import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runMemphisWebFetch } from '../../src/mcp/tools/web-fetch.js';

/**
 * SSRF regression net for #128. The old isSafeUrl:
 *  - missed 169.254/16 (cloud metadata), IPv6 private ranges,
 *    IPv4-mapped IPv6
 *  - fetched with redirect: 'follow', so a public URL could 302 to any
 *    internal address and the fetch executed
 * New runMemphisWebFetch: blocks those ranges, resolves DNS and re-checks
 * every returned IP, follows redirects manually with per-hop re-validation.
 */

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }]; // example.com

function mockFetch(impl: (url: string) => Partial<Response>): typeof fetch {
  return ((url: string) => {
    const r = impl(url);
    const headers = new Headers((r.headers as HeadersInit) ?? {});
    return Promise.resolve({
      status: r.status ?? 200,
      headers,
      text: r.text ?? (async () => ''),
    } as Response);
  }) as typeof fetch;
}

describe('mcp tools — web-fetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches a public URL successfully', async () => {
    const result = await runMemphisWebFetch(
      { url: 'https://example.com' },
      {
        dnsLookup: PUBLIC_LOOKUP,
        fetch: mockFetch(() => ({
          status: 200,
          text: async () => 'Hello World',
        })),
      },
    );
    expect(result.status).toBe(200);
    expect(result.content).toBe('Hello World');
    expect(result.truncated).toBe(false);
  });

  it('truncates responses over 4000 chars', async () => {
    const longContent = 'x'.repeat(5000);
    const result = await runMemphisWebFetch(
      { url: 'https://example.com/long' },
      {
        dnsLookup: PUBLIC_LOOKUP,
        fetch: mockFetch(() => ({ status: 200, text: async () => longContent })),
      },
    );
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

  // ── New coverage for #128 ────────────────────────────────────────────

  it('blocks 169.254.169.254 (cloud metadata endpoint)', async () => {
    await expect(
      runMemphisWebFetch({ url: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow(/URL blocked/);
  });

  it('blocks IPv6 loopback [::1]', async () => {
    await expect(runMemphisWebFetch({ url: 'http://[::1]/' })).rejects.toThrow(
      /URL blocked/,
    );
  });

  it('blocks IPv6 ULA [fc00::1]', async () => {
    await expect(runMemphisWebFetch({ url: 'http://[fc00::1]/' })).rejects.toThrow(
      /URL blocked/,
    );
  });

  it('blocks IPv6 link-local [fe80::1]', async () => {
    await expect(runMemphisWebFetch({ url: 'http://[fe80::1]/' })).rejects.toThrow(
      /URL blocked/,
    );
  });

  it('blocks IPv4-mapped IPv6 [::ffff:127.0.0.1]', async () => {
    await expect(
      runMemphisWebFetch({ url: 'http://[::ffff:127.0.0.1]/' }),
    ).rejects.toThrow(/URL blocked/);
  });

  it('blocks hostname that resolves to a private IP (DNS pre-check)', async () => {
    await expect(
      runMemphisWebFetch(
        { url: 'http://ssrf-bait.example.com/' },
        {
          // Attacker registers a public hostname pointing at cloud metadata.
          dnsLookup: async () => [{ address: '169.254.169.254' }],
        },
      ),
    ).rejects.toThrow(/private\/internal IP/);
  });

  it('blocks redirect to an internal IP (the real #128 bypass)', async () => {
    await expect(
      runMemphisWebFetch(
        { url: 'https://example.com/redirect-trap' },
        {
          dnsLookup: PUBLIC_LOOKUP,
          fetch: mockFetch((url) => {
            if (url.includes('redirect-trap')) {
              return {
                status: 302,
                headers: { location: 'http://169.254.169.254/latest/' },
              };
            }
            return { status: 200, text: async () => 'unreachable' };
          }),
        },
      ),
    ).rejects.toThrow(/private\/internal IP/);
  });

  it('caps redirect chain at 5 hops', async () => {
    let hopCount = 0;
    await expect(
      runMemphisWebFetch(
        { url: 'https://example.com/hop' },
        {
          dnsLookup: PUBLIC_LOOKUP,
          fetch: mockFetch(() => {
            hopCount += 1;
            return {
              status: 302,
              headers: { location: 'https://example.com/next' },
            };
          }),
        },
      ),
    ).rejects.toThrow(/too many redirects/);
    expect(hopCount).toBeGreaterThanOrEqual(5);
  });
});
