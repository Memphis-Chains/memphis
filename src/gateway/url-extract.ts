/* eslint-disable no-restricted-syntax */
//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
import { parseBool } from '../core/env.js';
import { isHostSafe } from '../core/ssrf-guard.js';

const GITHUB_RE = /(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i;
const URL_RE =
  /(?:https?:\/\/[^\s]+|www\.[^\s]+|[\w][\w-]*\.(?:com|pl|org|net|io|dev|ai|uk|de|fr|eu|info|co|me|app|gg|tv|cc|us|ca|br|ru|cn|jp|kr|in|au|nz|cz|sk|lt|lv|ee|se|no|fi|dk|nl|be|at|ch|it|es|pt|ro|hu|bg|hr|rs|si|ua|by|kz|xyz|tech|club|space|site|online|pro|store|shop|blog|live|world)(?:\/[^\s]*)?)/gi;

function normalizeUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

type FetchedContext = { url: string; content: string };
export type FetchUrlsFromMessageOptions = {
  rawEnv?: NodeJS.ProcessEnv;
  allowPrivateNetwork?: boolean;
};

async function fetchGithubRepo(owner: string, repo: string): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Memphis/5.0',
    Accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const [repoRes, readmeRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers,
      signal: AbortSignal.timeout(8000),
    }),
  ]);

  const parts: string[] = [];
  if (repoRes.ok) {
    const data = (await repoRes.json()) as {
      description?: string;
      stargazers_count?: number;
      language?: string;
      topics?: string[];
      updated_at?: string;
    };
    parts.push(`Repo: ${owner}/${repo}`);
    if (data.description) parts.push(`Description: ${data.description}`);
    if (data.language) parts.push(`Language: ${data.language}`);
    if (data.stargazers_count != null) parts.push(`Stars: ${data.stargazers_count}`);
    if (data.topics?.length) parts.push(`Topics: ${data.topics.join(', ')}`);
  }
  if (readmeRes.ok) {
    const data = (await readmeRes.json()) as { content?: string };
    if (data.content) {
      const text = Buffer.from(data.content, 'base64').toString('utf8');
      parts.push(`\nREADME (first 1500 chars):\n${text.slice(0, 1500)}`);
    }
  }
  return parts.join('\n');
}

async function fetchWebPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Memphis/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return `Failed to fetch ${url}: ${res.status}`;
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/**
 * Synchronous URL-shape + private-IP check used by `fetchUrlsFromMessage`
 * to gate the gateway turn-runtime auto-fetch path.
 *
 * Previously a weak prefix-only check that missed 169.254/16 (cloud
 * metadata: AWS / GCP / Azure), IPv6 loopback / ULA / link-local, IPv4-
 * mapped IPv6, and 172.32/12 false-positive-blocked. ADR-007 consolidates
 * the rules into `src/core/ssrf-guard.ts` so a single block-list change
 * applies to both this path and `src/mcp/tools/web-fetch.ts`.
 *
 * For non-IP hostnames the helper is intentionally fail-closed: a
 * poisoned public hostname that resolves to a private IP would otherwise
 * slip past this synchronous check. The async `assertHostSafe` does the
 * DNS resolution and per-address re-check.
 */
function isSafeUrl(url: string, allowPrivateNetwork = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.search.length > 200) return false;
  const host = parsed.hostname;
  if (allowPrivateNetwork) return true;
  // isHostSafe handles literal-IP + .local/.internal + IPv6 literal
  // checks. Non-IP hostnames return false here so the caller has to
  // run a DNS resolution before declaring the URL safe — that's the
  // rebinding defence.
  return isHostSafe(host, { allowPrivateNetwork });
}

const MAX_TOTAL_FETCHED_CHARS = 4000;

export async function fetchUrlsFromMessage(
  text: string,
  options: FetchUrlsFromMessageOptions = {},
): Promise<FetchedContext[]> {
  const urls = [...new Set(text.match(URL_RE) ?? [])].slice(0, 3);
  if (urls.length === 0) return [];
  const allowPrivateNetwork =
    options.allowPrivateNetwork ??
    parseBool(options.rawEnv?.MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK, false);

  const results = await Promise.allSettled(
    urls.map(async (rawUrl): Promise<FetchedContext> => {
      const url = normalizeUrl(rawUrl);
      if (!isSafeUrl(url, allowPrivateNetwork)) {
        return { url, content: '[blocked: URL failed safety check]' };
      }
      const ghMatch = url.match(GITHUB_RE);
      if (ghMatch) return { url, content: await fetchGithubRepo(ghMatch[1], ghMatch[2]) };
      return { url, content: await fetchWebPage(url) };
    }),
  );

  const fetched = results
    .filter((r): r is PromiseFulfilledResult<FetchedContext> => r.status === 'fulfilled')
    .map((r) => r.value);

  let totalChars = 0;
  return fetched.filter((f) => {
    totalChars += f.content.length;
    return totalChars <= MAX_TOTAL_FETCHED_CHARS;
  });
}
