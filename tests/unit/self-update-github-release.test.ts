import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkForUpdate,
  peekCachedUpdateResult,
  resetSelfUpdateCache,
} from '../../src/infra/self-update/github-release.js';

function mockReleaseResponse(body: Record<string, unknown>, ok = true, status = 200): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve({
      ok,
      status,
      json: async () => body,
    } as Response),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  resetSelfUpdateCache();
});

describe('checkForUpdate', () => {
  it('reports an available update when GitHub returns a newer tag', async () => {
    const fetchFn = mockReleaseResponse({
      tag_name: 'v1.5.0',
      name: 'Memphis 1.5.0',
      published_at: '2026-04-01T12:00:00Z',
      html_url: 'https://github.com/Memphis-Chains/memphis/releases/v1.5.0',
      tarball_url: 'https://api.github.com/repos/Memphis-Chains/memphis/tarball/v1.5.0',
      body: 'Headline release notes here.',
    });
    const result = await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000 });
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('1.5.0');
    expect(result.release?.tag).toBe('v1.5.0');
    expect(result.release?.bodyPreview).toBe('Headline release notes here.');
    expect(result.error).toBeUndefined();
  });

  it('reports up-to-date when the local version equals the latest', async () => {
    const fetchFn = mockReleaseResponse({ tag_name: 'v1.3.0' });
    const result = await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000 });
    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe('1.3.0');
  });

  it('reports up-to-date when local version is ahead of the published tag', async () => {
    const fetchFn = mockReleaseResponse({ tag_name: 'v1.2.0' });
    const result = await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000 });
    expect(result.updateAvailable).toBe(false);
  });

  it('returns an error inline when GitHub responds non-ok', async () => {
    const fetchFn = mockReleaseResponse({}, false, 503);
    const result = await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000 });
    expect(result.error).toMatch(/503/);
    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBeNull();
  });

  it('returns an error inline when the payload is malformed', async () => {
    const fetchFn = mockReleaseResponse({ no_tag_field: true });
    const result = await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000 });
    expect(result.error).toMatch(/malformed/);
    expect(result.latestVersion).toBeNull();
  });

  it('serves from cache within the TTL window', async () => {
    const fetchFn = mockReleaseResponse({ tag_name: 'v1.5.0' });
    await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000, cacheTtlMs: 60_000 });
    await checkForUpdate('1.3.0', { fetchFn, nowMs: 30_000, cacheTtlMs: 60_000 });
    expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
  });

  it('refetches once the cache TTL elapses', async () => {
    const fetchFn = mockReleaseResponse({ tag_name: 'v1.5.0' });
    await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000, cacheTtlMs: 60_000 });
    await checkForUpdate('1.3.0', { fetchFn, nowMs: 100_000, cacheTtlMs: 60_000 });
    expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(2);
  });

  it('truncates very long release bodies in the preview', async () => {
    const longBody = 'x'.repeat(1000);
    const fetchFn = mockReleaseResponse({ tag_name: 'v1.5.0', body: longBody });
    const result = await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000 });
    expect(result.release?.bodyPreview?.length).toBeLessThan(260);
    expect(result.release?.bodyPreview?.endsWith('…')).toBe(true);
  });

  it('honors MEMPHIS_UPDATE_REPO_SLUG override', async () => {
    const fetchFn = mockReleaseResponse({ tag_name: 'v1.5.0' });
    await checkForUpdate('1.3.0', {
      fetchFn,
      nowMs: 1_000,
      rawEnv: { MEMPHIS_UPDATE_REPO_SLUG: 'OtherOrg/memphis-fork' } as NodeJS.ProcessEnv,
    });
    const url = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as string;
    expect(url).toContain('OtherOrg/memphis-fork');
  });
});

describe('peekCachedUpdateResult', () => {
  it('returns null when no check has been performed', () => {
    expect(peekCachedUpdateResult()).toBeNull();
  });

  it('returns the most recent cached result without touching the network', async () => {
    const fetchFn = mockReleaseResponse({ tag_name: 'v1.5.0' });
    await checkForUpdate('1.3.0', { fetchFn, nowMs: 1_000 });
    const cached = peekCachedUpdateResult();
    expect(cached?.latestVersion).toBe('1.5.0');
    expect(cached?.updateAvailable).toBe(true);
  });
});
