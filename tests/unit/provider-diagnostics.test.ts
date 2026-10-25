import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('../../src/infra/logging/security-audit.js', () => ({ writeSecurityAudit: audit }));
import { probeProvider } from '../../src/providers/diagnostics.js';

let root: string;
let env: NodeJS.ProcessEnv;
const sentinel = 'synthetic-secret-must-not-escape';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'provider-probe-'));
  env = { MEMPHIS_DATA_DIR: root, MINIMAX_API_KEY: sentinel, MINIMAX_MODEL: 'synthetic-model' };
  audit.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('safe provider diagnostics', () => {
  it('local verification makes no request and does not claim remote authentication', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await probeProvider('minimax', {}, env)).toMatchObject({
      verification: 'local-credential',
      outcome: 'usable',
      cached: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'model-or-endpoint-not-found'],
    [429, 'rate-limited'],
    [400, 'bad-request'],
    [500, 'provider-error'],
  ])('maps HTTP %s without response content', async (status, outcome) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sentinel, { status: status as number })),
    );
    const result = await probeProvider('minimax', { remote: true }, env);
    expect(result.outcome).toBe(outcome);
    expect(JSON.stringify([result, audit.mock.calls])).not.toContain(sentinel);
  });
  it('generates through the existing client and persists quota across calls', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'MEMPHIS_OK' } }] })),
    );
    vi.stubGlobal('fetch', fetch);
    for (let n = 0; n < 10; n++)
      expect((await probeProvider('minimax', { remote: true }, env)).outcome).toBe('generated');
    expect((await probeProvider('minimax', { remote: true }, { ...env })).outcome).toBe(
      'rate-limited',
    );
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(sentinel);
  });
  it('returns safe network errors and refuses insecure destinations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(sentinel);
      }),
    );
    expect((await probeProvider('minimax', { remote: true }, env)).outcome).toBe('network-error');
    expect(
      (
        await probeProvider(
          'minimax',
          { remote: true },
          { ...env, MINIMAX_BASE_URL: 'http://example.invalid' },
        )
      ).outcome,
    ).toBe('destination-denied');
    expect(JSON.stringify(audit.mock.calls)).not.toContain(sentinel);
  });
  it('honors cancellation before a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort(new Error(sentinel));
    expect(
      (await probeProvider('minimax', { remote: true, signal: controller.signal }, env)).outcome,
    ).toBe('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['response', 'rejection'])(
    'does not serialize credential-bearing async %s payloads',
    async (mode) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          await Promise.resolve();
          if (mode === 'rejection')
            throw new Error(sentinel, {
              cause: { headers: { Authorization: sentinel }, nested: { body: sentinel } },
            });
          return new Response(JSON.stringify({ choices: [{ message: { content: sentinel } }] }));
        }),
      );
      const result = await probeProvider('minimax', { remote: true }, env);
      expect(result.outcome).toBe(mode === 'response' ? 'generated' : 'network-error');
      expect(JSON.stringify({ result, audit: audit.mock.calls })).not.toContain(sentinel);
    },
  );
});
