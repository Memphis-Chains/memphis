import { lookup } from 'node:dns/promises';
import net from 'node:net';

import { MEMPHIS_WEB_FETCH_TIMEOUT_MS } from '../../config/env-registry.js';
import { AppError } from '../../core/errors.js';

const MAX_BODY_CHARS = 4000;
// Phase 1.5.3: env-driven via MEMPHIS_WEB_FETCH_TIMEOUT_MS (default 1 min,
// was 8 s hardcode — operator constraint cost-unconstrained).
const FETCH_TIMEOUT_MS = MEMPHIS_WEB_FETCH_TIMEOUT_MS.read(process.env);
const MAX_REDIRECTS = 5;

export type MemphisWebFetchInput = {
  url: string;
};

export type MemphisWebFetchOutput = {
  url: string;
  status: number;
  content: string;
  truncated: boolean;
};

/**
 * Block list of dangerous IPv4 ranges. Beyond the obvious RFC1918 + localhost,
 * we also block:
 *  - 169.254.0.0/16   — link-local / cloud-provider metadata (AWS/GCP/Azure
 *                       use 169.254.169.254 for instance credentials).
 *  - 100.64.0.0/10    — CGNAT (RFC 6598).
 *  - 0.0.0.0/8        — "this host" on many stacks; resolves to localhost.
 *  - 224.0.0.0/4      — multicast.
 *  - 255.255.255.255  — limited broadcast.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Block list of dangerous IPv6 ranges:
 *  - ::1              — loopback
 *  - fc00::/7         — unique local addresses
 *  - fe80::/10        — link-local
 *  - ::ffff:0:0/96    — IPv4-mapped (must re-check against IPv4 blocklist)
 *  - ::/128, ::/96    — unspecified, compat range
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')) return true;
  if (normalized.startsWith('fea') || normalized.startsWith('feb')) return true; // fe80::/10
  if (normalized.startsWith('ff')) return true; // multicast
  // IPv4-mapped: ::ffff:a.b.c.d — extract and re-check
  const mappedMatch = normalized.match(/^::ffff:([0-9.]+)$/);
  if (mappedMatch) return isPrivateIPv4(mappedMatch[1]);
  // IPv4-mapped alt form: ::ffff:X:Y where X:Y is hex
  const hexMappedMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMappedMatch) {
    const hi = Number.parseInt(hexMappedMatch[1], 16);
    const lo = Number.parseInt(hexMappedMatch[2], 16);
    const ipv4 = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
    return isPrivateIPv4(ipv4);
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // unknown → unsafe
}

/** URL.hostname includes brackets for IPv6 literals — strip them. */
function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export interface SafeFetchDeps {
  /**
   * DNS resolver used for the pre-fetch host check. Override in tests so
   * adversarial hosts can be simulated without real DNS lookups.
   */
  dnsLookup?: (host: string) => Promise<Array<{ address: string }>>;
  /**
   * fetch impl. Override in tests to simulate redirects.
   */
  fetch?: typeof fetch;
}

async function assertHostSafe(host: string, deps: SafeFetchDeps): Promise<void> {
  const resolver = deps.dnsLookup ?? ((h) => lookup(h, { all: true }));
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(host);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: host could not be resolved', 403);
  }
  if (addresses.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: host resolved to no addresses', 403);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `URL blocked: host resolves to private/internal IP (${address})`,
        403,
      );
    }
  }
}

/**
 * First-pass URL sanity — protocol, query-string size, hostname literal IP
 * checks (catches the case where the URL is a direct private-IP literal
 * before we even try DNS).
 */
function assertUrlShapeSafe(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: invalid URL', 403);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: only http(s) is allowed', 403);
  }
  if (parsed.search.length > 200) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: query string too long', 403);
  }
  // URL.hostname keeps the brackets on IPv6 literals (e.g. "[::1]"),
  // which would make net.isIP return 0 and skip the private-IP check,
  // and would poison dns.lookup with a non-resolvable bracketed string.
  // Strip the brackets before any host-classification logic.
  const host = stripIpv6Brackets(parsed.hostname.toLowerCase());
  if (!host) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: empty host', 403);
  }
  if (host === 'localhost') {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: localhost', 403);
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: .local/.internal domain', 403);
  }
  // Literal-IP shortcut: if the host is already an IP literal we can check
  // it directly without DNS.
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `URL blocked: private/internal IP literal (${host})`,
        403,
      );
    }
  }
  return parsed;
}

export async function runMemphisWebFetch(
  input: MemphisWebFetchInput,
  deps: SafeFetchDeps = {},
): Promise<MemphisWebFetchOutput> {
  const fetchImpl = deps.fetch ?? fetch;
  let currentUrl = input.url;
  let currentParsed = assertUrlShapeSafe(currentUrl);

  await assertHostSafe(stripIpv6Brackets(currentParsed.hostname), deps);

  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await fetchImpl(currentUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Memphis/5.0 MCP-Tool' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });

    // Follow redirect manually after re-validating the target.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, currentUrl).toString();
      currentUrl = next;
      currentParsed = assertUrlShapeSafe(currentUrl);
      await assertHostSafe(stripIpv6Brackets(currentParsed.hostname), deps);
      if (hop === MAX_REDIRECTS) {
        throw new AppError('VALIDATION_ERROR', 'URL blocked: too many redirects', 403);
      }
      continue;
    }
    break;
  }

  if (!response) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: no response', 403);
  }

  const raw = await response.text();
  const truncated = raw.length > MAX_BODY_CHARS;
  const content = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw;

  return {
    url: currentUrl,
    status: response.status,
    content,
    truncated,
  };
}
