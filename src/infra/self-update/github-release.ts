/**
 * GitHub releases check for `memphis self-update --check` and the
 * `latestVersion` field on `/v1/ops/status`.
 *
 * Stays read-only and cached: the operator-facing check just tells
 * you whether a newer version exists. Install / rollback mechanics
 * are tracked as a follow-up sprint so the actual tarball extraction
 * + symlink swap can be tested end-to-end against real release
 * artifacts.
 */

import { isNewerVersion } from './semver.js';

export interface GithubReleaseInfo {
  tag: string;
  name?: string;
  publishedAt?: string;
  htmlUrl?: string;
  tarballUrl?: string;
  bodyPreview?: string;
}

export interface SelfUpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  release?: GithubReleaseInfo;
  error?: string;
  checkedAt: string;
}

interface CacheEntry {
  result: SelfUpdateCheckResult;
  fetchedAtMs: number;
}

interface FetchOptions {
  fetchFn?: typeof fetch;
  repoSlug?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  nowMs?: number;
  rawEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_REPO_SLUG = 'Memphis-Chains/memphis';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const BODY_PREVIEW_MAX = 240;

let cachedEntry: CacheEntry | null = null;

function resolveRepoSlug(options: FetchOptions): string {
  return (
    options.repoSlug?.trim() ||
    options.rawEnv?.MEMPHIS_UPDATE_REPO_SLUG?.trim() ||
    process.env.MEMPHIS_UPDATE_REPO_SLUG?.trim() ||
    DEFAULT_REPO_SLUG
  );
}

function resolveFetchFn(options: FetchOptions): typeof fetch {
  return options.fetchFn ?? fetch;
}

function withTimeout(timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref?.();
  return ctrl.signal;
}

function normalizeBody(body: string | undefined | null): string | undefined {
  if (!body) return undefined;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > BODY_PREVIEW_MAX
    ? `${flat.slice(0, BODY_PREVIEW_MAX - 1)}…`
    : flat;
}

function parseRelease(raw: unknown): GithubReleaseInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const tag = typeof rec.tag_name === 'string' ? rec.tag_name : null;
  if (!tag) return null;
  const name = typeof rec.name === 'string' ? rec.name : undefined;
  const publishedAt =
    typeof rec.published_at === 'string' ? rec.published_at : undefined;
  const htmlUrl = typeof rec.html_url === 'string' ? rec.html_url : undefined;
  const tarballUrl =
    typeof rec.tarball_url === 'string' ? rec.tarball_url : undefined;
  const bodyPreview = normalizeBody(
    typeof rec.body === 'string' ? rec.body : undefined,
  );
  return { tag, name, publishedAt, htmlUrl, tarballUrl, bodyPreview };
}

/**
 * Query the latest release; returns a structured result with a
 * `updateAvailable` boolean. Errors (network, rate-limit, parse) are
 * reported inline rather than thrown so callers can surface the result
 * in `/status` without risk.
 */
function readEnvCacheTtlMs(rawEnv: NodeJS.ProcessEnv | undefined): number | undefined {
  const raw = (rawEnv ?? process.env).MEMPHIS_UPDATE_CACHE_TTL_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

export async function checkForUpdate(
  currentVersion: string,
  options: FetchOptions = {},
): Promise<SelfUpdateCheckResult> {
  const nowMs = options.nowMs ?? Date.now();
  // Codex P2 fix (PR #90): honor MEMPHIS_UPDATE_CACHE_TTL_MS env so
  // operators can tune freshness vs rate-limit tradeoffs without code
  // changes. Precedence: explicit option > env > DEFAULT_CACHE_TTL_MS.
  const cacheTtlMs =
    options.cacheTtlMs ?? readEnvCacheTtlMs(options.rawEnv) ?? DEFAULT_CACHE_TTL_MS;

  if (cachedEntry && nowMs - cachedEntry.fetchedAtMs < cacheTtlMs) {
    return cachedEntry.result;
  }

  const repoSlug = resolveRepoSlug(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `https://api.github.com/repos/${repoSlug}/releases/latest`;
  const fetchFn = resolveFetchFn(options);

  const result: SelfUpdateCheckResult = {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    checkedAt: new Date(nowMs).toISOString(),
  };

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `memphis-self-update/${currentVersion}`,
      },
      signal: withTimeout(timeoutMs),
    });
    if (!res.ok) {
      result.error = `github responded ${res.status}`;
    } else {
      const raw = (await res.json()) as unknown;
      const release = parseRelease(raw);
      if (!release) {
        result.error = 'malformed github release payload';
      } else {
        result.release = release;
        result.latestVersion = release.tag.replace(/^v/, '');
        result.updateAvailable = isNewerVersion(
          currentVersion,
          result.latestVersion,
        );
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  // Codex P2 fix (PR #90): only cache successful results. Caching errors
  // for the full TTL means a transient 503 / timeout sticks around for
  // 5 min even after GitHub recovers; subsequent operator-driven
  // `memphis self-update check` invocations would replay stale failures.
  // Successful checks (with or without an updateAvailable) get cached.
  if (!result.error) {
    cachedEntry = { result, fetchedAtMs: nowMs };
  }
  return result;
}

/**
 * Return whatever is currently cached without touching the network.
 * `/v1/ops/status` uses this so status latency never depends on GitHub.
 * The cache is populated on demand by `memphis self-update check` or
 * the next scheduled background refresh.
 */
export function peekCachedUpdateResult(): SelfUpdateCheckResult | null {
  return cachedEntry?.result ?? null;
}

/** Test-only cache reset. */
export function resetSelfUpdateCache(): void {
  cachedEntry = null;
}
