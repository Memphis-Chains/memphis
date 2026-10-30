import {
  MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK,
  MEMPHIS_WEB_FETCH_TIMEOUT_MS,
} from '../../config/env-registry.js';
import { parseBool } from '../../core/env.js';
import { AppError } from '../../core/errors.js';
import {
  assertHostSafe,
  assertUrlShapeSafe,
  stripIpv6Brackets,
  type SafeFetchDeps,
} from '../../core/ssrf-guard.js';

// Re-export so existing importers (src/mcp/server.ts, src/gateway/...)
// that pull `SafeFetchDeps` from this module keep working.
export type { SafeFetchDeps };

/// How many bytes of the body a fetch returns.
///
/// The native arm has always read 32 000 and the cockpit advertises
/// that to the model. This arm truncated at 4 000, with a test pinning
/// that number since the tool landed, so the same URL answered
/// differently depending on which surface the model was talking to.
///
/// 4 000 bytes of a documentation page is the first paragraph and the
/// navigation menu -- a fragment the model cannot use. 32 000 bytes is
/// about 8 000 tokens against a 475 000-token window, so it is bounded
/// and still useful. The number is a parameter now, so the two arms
/// agree and the caller can ask for less.
const MAX_BODY_BYTES = 32_000;
// Phase 1.5.3: env-driven via MEMPHIS_WEB_FETCH_TIMEOUT_MS (default 1 min,
// was 8 s hardcode — operator constraint cost-unconstrained).
const FETCH_TIMEOUT_MS = MEMPHIS_WEB_FETCH_TIMEOUT_MS.read(process.env);
const MAX_REDIRECTS = 5;

/**
 * Cut a body to a number of UTF-8 bytes without splitting a character
 * in half.
 */
function sliceUtf8Bytes(text: string, maxBytes: number): { content: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return { content: text, truncated: false };
  }
  let end = maxBytes;
  // A continuation byte means the character it belongs to starts
  // earlier, so the cut moves back to the character's first byte.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { content: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

export type MemphisWebFetchInput = {
  url: string;
  /** The most bytes of the body to return (1..32000). */
  maxBytes?: number;
};

export type MemphisWebFetchOutput = {
  url: string;
  status: number;
  content: string;
  truncated: boolean;
};

export async function runMemphisWebFetch(
  input: MemphisWebFetchInput,
  deps: SafeFetchDeps = {},
): Promise<MemphisWebFetchOutput> {
  const fetchImpl = deps.fetch ?? fetch;
  let currentUrl = input.url;
  const effectiveDeps = {
    ...deps,
    allowPrivateNetwork:
      deps.allowPrivateNetwork ??
      parseBool(MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK.read(process.env), false),
  };
  let currentParsed = assertUrlShapeSafe(currentUrl, effectiveDeps);

  await assertHostSafe(stripIpv6Brackets(currentParsed.hostname), effectiveDeps);

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
      currentParsed = assertUrlShapeSafe(currentUrl, effectiveDeps);
      await assertHostSafe(stripIpv6Brackets(currentParsed.hostname), effectiveDeps);
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
  // Counted in bytes, like the native arm: a page with Polish text
  // must not be cut differently on the two surfaces.
  const maxBytes = Math.min(Math.max(input.maxBytes ?? MAX_BODY_BYTES, 1), MAX_BODY_BYTES);
  const { content, truncated } = sliceUtf8Bytes(raw, maxBytes);

  return {
    url: currentUrl,
    status: response.status,
    content,
    truncated,
  };
}
