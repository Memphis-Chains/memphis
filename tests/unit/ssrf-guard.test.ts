import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertHostSafe,
  assertUrlShapeSafe,
  isHostSafe,
  isPrivateIp,
  isPrivateIPv4,
  isPrivateIPv6,
  stripIpv6Brackets,
} from '../../src/core/ssrf-guard.js';

// Same env-isolation dance as tests/unit/mcp-web-fetch.test.ts: the
// operator-level opt-in lives in the project .env and would silently
// disable every assertion below.
const ORIGINAL_FLAG = process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
beforeAll(() => {
  delete process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
});
afterAll(() => {
  if (ORIGINAL_FLAG !== undefined) {
    process.env.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK = ORIGINAL_FLAG;
  }
});

describe('ssrf-guard primitives', () => {
  describe('isPrivateIPv4', () => {
    const privateRanges = [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.1',
      '192.168.255.255',
      '169.254.0.1',
      '169.254.169.254', // AWS / GCP / Azure metadata
      '100.64.0.1',
      '100.127.255.254',
      '0.0.0.0',
      '224.0.0.1',
      '239.255.255.255',
      '255.255.255.255',
    ];
    const publicRanges = [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1', // NOT in RFC1918 — boundary case the old prefix check got wrong
      '172.15.0.1',
      '172.33.0.1',
      '9.9.9.9',
    ];
    for (const ip of privateRanges) {
      it(`flags ${ip} as private`, () => {
        expect(isPrivateIPv4(ip)).toBe(true);
      });
    }
    for (const ip of publicRanges) {
      it(`flags ${ip} as public`, () => {
        expect(isPrivateIPv4(ip)).toBe(false);
      });
    }
    it('treats malformed IPv4 as private (fail-closed)', () => {
      expect(isPrivateIPv4('999.999.999.999')).toBe(true);
      expect(isPrivateIPv4('not.an.ip.addr')).toBe(true);
    });
  });

  describe('isPrivateIPv6', () => {
    it('flags ::1 (loopback) as private', () => {
      expect(isPrivateIPv6('::1')).toBe(true);
    });
    it('flags :: (unspecified) as private', () => {
      expect(isPrivateIPv6('::')).toBe(true);
    });
    it('flags fc00::/7 unique-local as private', () => {
      expect(isPrivateIPv6('fc00::1')).toBe(true);
      expect(isPrivateIPv6('fd12:3456:789a::1')).toBe(true);
    });
    it('flags fe80::/10 link-local as private', () => {
      expect(isPrivateIPv6('fe80::1')).toBe(true);
      expect(isPrivateIPv6('feb0::1')).toBe(true);
    });
    it('flags ff00::/8 multicast as private', () => {
      expect(isPrivateIPv6('ff02::1')).toBe(true);
    });
    it('flags IPv4-mapped IPv6 (dotted form) by re-checking the embedded IPv4', () => {
      expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
    });
    it('flags IPv4-mapped IPv6 (hex form) by re-checking the embedded IPv4', () => {
      // 0.0.0.0 in hex mapped form
      expect(isPrivateIPv6('::ffff:0:0')).toBe(true);
      // 8.8.8.8 = 0x0808:0x0808 in IPv4-mapped IPv6 hex form
      expect(isPrivateIPv6('::ffff:808:808')).toBe(false);
      // 1.1.1.1 = 0x0101:0x0101
      expect(isPrivateIPv6('::ffff:101:101')).toBe(false);
    });
    it('flags public IPv6 addresses as public', () => {
      expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
    });
  });

  describe('isPrivateIp dispatcher', () => {
    it('routes IPv4 to isPrivateIPv4', () => {
      expect(isPrivateIp('10.0.0.1')).toBe(true);
      expect(isPrivateIp('8.8.8.8')).toBe(false);
    });
    it('routes IPv6 to isPrivateIPv6', () => {
      expect(isPrivateIp('::1')).toBe(true);
      expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
    });
    it('treats unparseable input as private (fail-closed)', () => {
      expect(isPrivateIp('not-an-ip')).toBe(true);
      expect(isPrivateIp('')).toBe(true);
    });
  });

  describe('stripIpv6Brackets', () => {
    it('strips bracketed IPv6 literals', () => {
      expect(stripIpv6Brackets('[::1]')).toBe('::1');
      expect(stripIpv6Brackets('[2001:4860:4860::8888]')).toBe('2001:4860:4860::8888');
    });
    it('passes through non-bracketed hosts', () => {
      expect(stripIpv6Brackets('example.com')).toBe('example.com');
      expect(stripIpv6Brackets('::1')).toBe('::1');
      expect(stripIpv6Brackets('')).toBe('');
    });
  });
});

describe('ssrf-guard isHostSafe (synchronous helper for non-URL callers)', () => {
  it('blocks IPv4 private literals', () => {
    expect(isHostSafe('10.0.0.1')).toBe(false);
    expect(isHostSafe('192.168.1.1')).toBe(false);
    expect(isHostSafe('169.254.169.254')).toBe(false); // metadata
    expect(isHostSafe('127.0.0.1')).toBe(false);
  });
  it('blocks IPv6 private literals (the gap the old url-extract guard had)', () => {
    expect(isHostSafe('::1')).toBe(false);
    expect(isHostSafe('fc00::1')).toBe(false);
    expect(isHostSafe('fe80::1')).toBe(false);
    expect(isHostSafe('[::1]')).toBe(false); // bracketed form
  });
  it('blocks .local and .internal suffixes', () => {
    expect(isHostSafe('host.local')).toBe(false);
    expect(isHostSafe('host.internal')).toBe(false);
  });
  it('blocks empty / whitespace hosts', () => {
    expect(isHostSafe('')).toBe(false);
  });
  it('allows public IPv4 literals', () => {
    expect(isHostSafe('8.8.8.8')).toBe(true);
    expect(isHostSafe('172.32.0.1')).toBe(true); // boundary case
  });
  it('returns false (fail-closed) for non-IP hostnames — DNS re-check required', () => {
    // We deliberately fail closed so the async assertHostSafe has to run.
    expect(isHostSafe('example.com')).toBe(false);
    expect(isHostSafe('attacker-controlled.example')).toBe(false);
  });
  it('honours allowPrivateNetwork for IP literals', () => {
    expect(isHostSafe('10.0.0.1', { allowPrivateNetwork: true })).toBe(true);
    expect(isHostSafe('127.0.0.1', { allowPrivateNetwork: true })).toBe(true);
  });
});

describe('ssrf-guard assertHostSafe (async DNS-resolving helper)', () => {
  it('passes public-host DNS results through', async () => {
    await expect(
      assertHostSafe('example.com', {
        dnsLookup: async () => [{ address: '93.184.216.34' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects host that resolves to private IP (DNS rebinding defence)', async () => {
    await expect(
      assertHostSafe('attacker.example', {
        dnsLookup: async () => [{ address: '10.0.0.1' }],
      }),
    ).rejects.toThrow(/URL blocked: host resolves to private\/internal IP/);
  });

  it('rejects host that resolves to cloud-metadata IP', async () => {
    await expect(
      assertHostSafe('metadata.example', {
        dnsLookup: async () => [{ address: '169.254.169.254' }],
      }),
    ).rejects.toThrow(/private\/internal IP/);
  });

  it('rejects host that resolves to IPv6 private (::1)', async () => {
    await expect(
      assertHostSafe('attacker.example', {
        dnsLookup: async () => [{ address: '::1' }],
      }),
    ).rejects.toThrow(/private\/internal IP/);
  });

  it('rejects host with no DNS results', async () => {
    await expect(
      assertHostSafe('no-results.example', {
        dnsLookup: async () => [],
      }),
    ).rejects.toThrow(/resolved to no addresses/);
  });

  it('rejects host that fails to resolve', async () => {
    await expect(
      assertHostSafe('nx.example', {
        dnsLookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it('skips entirely under allowPrivateNetwork (operator opt-in)', async () => {
    await expect(
      assertHostSafe('10.0.0.1', {
        allowPrivateNetwork: true,
        dnsLookup: async () => [{ address: '10.0.0.1' }],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('ssrf-guard assertUrlShapeSafe (URL parsing + literal checks)', () => {
  it('rejects non-http(s) protocols', () => {
    expect(() => assertUrlShapeSafe('file:///etc/passwd', {})).toThrow(/only http\(s\) is allowed/);
    expect(() => assertUrlShapeSafe('javascript:alert(1)', {})).toThrow(/only http\(s\) is allowed/);
  });

  it('rejects URLs that fail to parse', () => {
    expect(() => assertUrlShapeSafe('not a url', {})).toThrow(/invalid URL/);
  });

  it('rejects oversized query strings (>200 chars)', () => {
    const big = `https://example.com/?${'a'.repeat(300)}`;
    expect(() => assertUrlShapeSafe(big, {})).toThrow(/query string too long/);
  });

  it('rejects private IPv4 literals as the host', () => {
    expect(() => assertUrlShapeSafe('http://169.254.169.254/latest', {})).toThrow(
      /private\/internal IP literal/,
    );
  });

  it('rejects bracketed private IPv6 literals as the host', () => {
    expect(() => assertUrlShapeSafe('http://[::1]/admin', {})).toThrow(
      /private\/internal IP literal/,
    );
  });

  it('rejects .local and .internal domains before any DNS lookup', () => {
    expect(() => assertUrlShapeSafe('http://host.local/admin', {})).toThrow(
      /\.local\/.internal domain/,
    );
    expect(() => assertUrlShapeSafe('http://host.internal/admin', {})).toThrow(
      /\.local\/.internal domain/,
    );
  });

  it('rejects the literal "localhost" hostname', () => {
    expect(() => assertUrlShapeSafe('http://localhost:3000', {})).toThrow(/localhost/);
  });

  it('returns the parsed URL for public https inputs', () => {
    const parsed = assertUrlShapeSafe('https://example.com/path?q=1', {});
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.protocol).toBe('https:');
  });

  it('honours allowPrivateNetwork for private IP literals (operator opt-in)', () => {
    expect(() =>
      assertUrlShapeSafe('http://10.0.0.1/admin', { allowPrivateNetwork: true }),
    ).not.toThrow();
    expect(() =>
      assertUrlShapeSafe('http://localhost:3000', { allowPrivateNetwork: true }),
    ).not.toThrow();
  });
});