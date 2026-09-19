import { lookup } from 'node:dns/promises';
import net from 'node:net';

import { AppError } from './errors.js';

/**
 * SSRF guard helpers — single source of truth for outbound URL safety.
 *
 * Extracted from `src/mcp/tools/web-fetch.ts` in ADR-007. Both that
 * module and `src/gateway/url-extract.ts` delegate here so a new
 * block-list rule applies everywhere in one commit. The module has no
 * dependency on the MCP server / HTTP transport — only `node:dns`,
 * `node:net`, and `node:url` plus the project-local `AppError`.
 */

/** URL.hostname includes brackets for IPv6 literals — strip them. */
export function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

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
export function isPrivateIPv4(ip: string): boolean {
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
export function isPrivateIPv6(ip: string): boolean {
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

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // unknown → unsafe
}

export interface SafeFetchDeps {
  /**
   * DNS resolver used for the pre-fetch host check. Override in tests so
   * adversarial hosts can be simulated without real DNS lookups.
   */
  dnsLookup?: (host: string) => Promise<Array<{ address: string }>>;
  /**
   * fetch impl. Override in tests to simulate redirects / canned bodies
   * without hitting the network. The web-fetch / url-extract callers
   * fall back to the global `fetch` when this is omitted.
   */
  fetch?: typeof fetch;
  /**
   * Operator-elevated mode for local dashboards and Memphis-managed services.
   * Defaults closed because public web fetch must not be an SSRF primitive.
   */
  allowPrivateNetwork?: boolean;
}

/**
 * Resolve `host` via the configured resolver (or real DNS) and reject if
 * any returned address is private / loopback / link-local / metadata.
 * Skipped entirely when `allowPrivateNetwork` is true (operator opt-in
 * for local dashboards).
 */
export async function assertHostSafe(host: string, deps: SafeFetchDeps): Promise<void> {
  if (deps.allowPrivateNetwork) return;
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
 * before we even try DNS). Returns the parsed URL on success.
 */
export function assertUrlShapeSafe(rawUrl: string, deps: SafeFetchDeps): URL {
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
  if (!deps.allowPrivateNetwork && host === 'localhost') {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: localhost', 403);
  }
  if (!deps.allowPrivateNetwork && (host.endsWith('.local') || host.endsWith('.internal'))) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: .local/.internal domain', 403);
  }
  // Literal-IP shortcut: if the host is already an IP literal we can check
  // it directly without DNS.
  if (net.isIP(host) !== 0) {
    if (!deps.allowPrivateNetwork && isPrivateIp(host)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `URL blocked: private/internal IP literal (${host})`,
        403,
      );
    }
  }
  return parsed;
}

/**
 * Synchronous single-call helper used by callers that already have a
 * hostname in hand (no URL parsing needed). Returns true when the host
 * is safe to fetch in the current `allowPrivateNetwork` mode.
 *
 * This is the gateway/url-extract path's primary entry point — its
 * `isSafeUrl` previously did a much weaker prefix-only check that missed
 * 169.254/16, IPv6 private ranges, IPv4-mapped IPv6, and IPv6 literals.
 */
export function isHostSafe(host: string, deps: SafeFetchDeps = {}): boolean {
  if (deps.allowPrivateNetwork) return true;
  const bare = stripIpv6Brackets(host.toLowerCase());
  if (!bare) return false;
  if (bare === 'localhost') return false;
  if (bare.endsWith('.local') || bare.endsWith('.internal')) return false;
  if (net.isIP(bare) !== 0) {
    return !isPrivateIp(bare);
  }
  // Non-IP hostnames need a DNS lookup to classify; return false (fail
  // closed) so callers can't accidentally bypass the DNS-rebinding
  // defense by skipping the lookup. Callers that want a synchronous
  // safe-by-prefix check should compose this with `assertHostSafe`.
  return false;
}