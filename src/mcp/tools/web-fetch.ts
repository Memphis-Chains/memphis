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
  const truncated = raw.length > MAX_BODY_CHARS;
  const content = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw;

  return {
    url: currentUrl,
    status: response.status,
    content,
    truncated,
  };
}
