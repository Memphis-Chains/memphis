const GITHUB_RE = /(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i;
const URL_RE =
  /(?:https?:\/\/[^\s]+|www\.[^\s]+|[\w][\w-]*\.(?:com|pl|org|net|io|dev|ai|uk|de|fr|eu|info|co|me|app|gg|tv|cc|us|ca|br|ru|cn|jp|kr|in|au|nz|cz|sk|lt|lv|ee|se|no|fi|dk|nl|be|at|ch|it|es|pt|ro|hu|bg|hr|rs|si|ua|by|kz|xyz|tech|club|space|site|online|pro|store|shop|blog|live|world)(?:\/[^\s]*)?)/gi;

function normalizeUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

type FetchedContext = { url: string; content: string };

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

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.search.length > 200) return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      host.startsWith('172.')
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

const MAX_TOTAL_FETCHED_CHARS = 4000;

export async function fetchUrlsFromMessage(text: string): Promise<FetchedContext[]> {
  const urls = [...new Set(text.match(URL_RE) ?? [])].slice(0, 3);
  if (urls.length === 0) return [];

  const results = await Promise.allSettled(
    urls.map(async (rawUrl): Promise<FetchedContext> => {
      const url = normalizeUrl(rawUrl);
      if (!isSafeUrl(url)) return { url, content: '[blocked: URL failed safety check]' };
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
