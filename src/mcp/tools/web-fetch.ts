import { AppError } from '../../core/errors.js';

const MAX_BODY_CHARS = 4000;
const FETCH_TIMEOUT_MS = 8000;

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
 * Check if a URL is safe to fetch (blocks SSRF to internal networks).
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.search.length > 200) return false;

    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]') return false;
    if (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return false;
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;
    return true;
  } catch {
    return false;
  }
}

export async function runMemphisWebFetch(input: MemphisWebFetchInput): Promise<MemphisWebFetchOutput> {
  if (!isSafeUrl(input.url)) {
    throw new AppError('VALIDATION_ERROR', 'URL blocked: internal/private addresses not allowed', 403);
  }

  const response = await fetch(input.url, {
    method: 'GET',
    headers: { 'User-Agent': 'Memphis/5.0 MCP-Tool' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });

  const raw = await response.text();
  const truncated = raw.length > MAX_BODY_CHARS;
  const content = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw;

  return {
    url: input.url,
    status: response.status,
    content,
    truncated,
  };
}
