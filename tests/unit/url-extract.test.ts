import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchUrlsFromMessage } from '../../src/gateway/url-extract.js';

// Same env-isolation dance as ssrf-guard.test.ts: the operator-level
// opt-in lives in the project .env and would silently disable every
// assertion below.
const ORIGINAL_FLAG = process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
beforeAll(() => {
  delete process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
});
afterAll(() => {
  if (ORIGINAL_FLAG !== undefined) {
    process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK = ORIGINAL_FLAG;
  }
});

/**
 * ADR-007 regression net: the gateway turn-runtime auto-fetch path
 * (`src/gateway/turn-runtime.ts:843` calls `fetchUrlsFromMessage`)
 * must apply the same SSRF guard as the explicit MCP `memphis_web_fetch`
 * tool. Previously `isSafeUrl` did a prefix-only hostname check that
 * missed 169.254/16 (cloud metadata), IPv6 private ranges, and
 * IPv4-mapped IPv6 — every one of those tests below is a
 * regression-fence.
 */
describe('url-extract — fetchUrlsFromMessage (gateway auto-fetch)', () => {
  it('blocks cloud-metadata IPs through the gateway path (the headline fix)', async () => {
    const fetched = await fetchUrlsFromMessage(
      'check this http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      { rawEnv: {} },
    );
    expect(fetched).toEqual([
      {
        url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        content: '[blocked: URL failed safety check]',
      },
    ]);
  });

  it('blocks IPv6 loopback', async () => {
    const fetched = await fetchUrlsFromMessage('see http://[::1]/admin', { rawEnv: {} });
    expect(fetched[0]?.content).toBe('[blocked: URL failed safety check]');
  });

  it('blocks IPv6 unique-local (fc00::/7)', async () => {
    const fetched = await fetchUrlsFromMessage('see http://[fc00::1]/admin', { rawEnv: {} });
    expect(fetched[0]?.content).toBe('[blocked: URL failed safety check]');
  });

  it('blocks IPv6 link-local (fe80::/10)', async () => {
    const fetched = await fetchUrlsFromMessage('see http://[fe80::1]/admin', { rawEnv: {} });
    expect(fetched[0]?.content).toBe('[blocked: URL failed safety check]');
  });

  it('blocks IPv4-mapped IPv6 of 127.0.0.1 (the older check missed this)', async () => {
    const fetched = await fetchUrlsFromMessage('see http://[::ffff:127.0.0.1]/admin', {
      rawEnv: {},
    });
    expect(fetched[0]?.content).toBe('[blocked: URL failed safety check]');
  });

  it('blocks IPv4-mapped IPv6 of 169.254.169.254', async () => {
    const fetched = await fetchUrlsFromMessage(
      'see http://[::ffff:169.254.169.254]/latest/meta-data/',
      { rawEnv: {} },
    );
    expect(fetched[0]?.content).toBe('[blocked: URL failed safety check]');
  });

  it('blocks CGNAT range (100.64/10) — was previously reachable', async () => {
    const fetched = await fetchUrlsFromMessage('see http://100.64.0.1/admin', { rawEnv: {} });
    expect(fetched[0]?.content).toBe('[blocked: URL failed safety check]');
  });

  it('blocks 0.0.0.0/8', async () => {
    const fetched = await fetchUrlsFromMessage('see http://0.0.0.0/admin', { rawEnv: {} });
    expect(fetched[0]?.content).toBe('[blocked: URL failed safety check]');
  });

  it('returns the empty array for messages with no URLs', async () => {
    const fetched = await fetchUrlsFromMessage(
      'plain prose with no links, just words and punctuation',
      { rawEnv: {} },
    );
    expect(fetched).toEqual([]);
  });

  it('returns the empty array for non-http schemes (file://, etc.)', async () => {
    // URL_RE matches only http(s)/www/dot-tld patterns. A `file://`
    // URL never makes it into the urls list, so fetchUrlsFromMessage
    // returns [] — the headline SSRF guard is for things that *would*
    // be fetched if not blocked, and file:// is filtered upstream by the
    // URL matcher. Note this is the gateway message-scanner path; the
    // explicit MCP tool (web-fetch.ts) does enforce http(s)-only.
    const fetched = await fetchUrlsFromMessage('see file:///etc/passwd', { rawEnv: {} });
    expect(fetched).toEqual([]);
  });

  it('honours MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK env override', async () => {
    const prev = process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
    process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK = 'true';
    try {
      // 127.0.0.1 normally blocked — under the opt-in isSafeUrl returns
      // true and the gateway attempts the fetch. We don't care about the
      // fetch outcome here, only that isSafeUrl doesn't short-circuit to
      // a `[blocked: ...]` content string.
      const fetched = await fetchUrlsFromMessage('see http://127.0.0.1:3000/health', {
        rawEnv: process.env,
      });
      // With opt-in the URL is fetched (or fails for its own reasons),
      // but isSafeUrl does NOT return the [blocked: ...] sentinel.
      if (fetched.length > 0) {
        expect(fetched[0]?.content.startsWith('[blocked')).toBe(false);
      }
    } finally {
      if (prev === undefined) {
        delete process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
      } else {
        process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK = prev;
      }
    }
  });
});