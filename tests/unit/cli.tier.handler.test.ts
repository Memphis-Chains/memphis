/**
 * Unit tests for `memphis tier status` CLI handler.
 *
 * The handler queries the daemon over HTTP (sessions live in the daemon's
 * in-process Map), so we mock global `fetch` to drive every code path
 * without standing up a real server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { tierCommandHandler } from '../../src/infra/cli/handlers/tier.handler.js';

interface ConsoleSpy {
  log: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
}

let consoleSpy: ConsoleSpy;

beforeEach(() => {
  consoleSpy = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
});

afterEach(() => {
  consoleSpy.log.mockRestore();
  consoleSpy.error.mockRestore();
  vi.restoreAllMocks();
});

function buildContext(opts: {
  json?: boolean;
  subcommand?: string;
  token?: string;
  argv?: string[];
} = {}): CliContext {
  return {
    argv: opts.argv ?? [],
    args: {
      command: 'tier',
      subcommand: opts.subcommand ?? 'status',
      json: opts.json ?? false,
    } as CliContext['args'],
    getConfig: () =>
      ({
        HOST: '127.0.0.1',
        PORT: 3100,
        MEMPHIS_API_TOKEN: opts.token ?? 'test-token',
      }) as ReturnType<CliContext['getConfig']>,
    getContainer: () => ({}) as ReturnType<CliContext['getContainer']>,
  };
}

function mockFetchResolve(payload: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function mockFetchReject(error: Error): void {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(error)));
}

describe('memphis tier status', () => {
  it('prints human-format output with empty sessions list', async () => {
    mockFetchResolve({
      ok: true,
      count: 0,
      sessions: [],
      asOf: '2026-04-26T12:00:00.000Z',
    });

    await tierCommandHandler.handle(buildContext());

    const output = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Tier-3 sessions: 0 active');
    expect(output).toContain('(no active sessions');
  });

  it('prints human-format output with one populated session', async () => {
    mockFetchResolve({
      ok: true,
      count: 1,
      sessions: [
        {
          surface: 'telegram',
          actorId: '1316033647',
          grantedAt: '2026-04-26T11:30:00.000Z',
          expiresAt: '2026-04-26T14:30:00.000Z',
          remainingMs: 6420000,
        },
      ],
      asOf: '2026-04-26T12:43:00.000Z',
    });

    await tierCommandHandler.handle(buildContext());

    const output = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Tier-3 sessions: 1 active');
    expect(output).toContain('[telegram:1316033647]');
    expect(output).toContain('granted:');
    expect(output).toContain('expires:');
    expect(output).toContain('1h47m'); // 6420000ms ≈ 1h47m
  });

  it('--json flag emits parseable JSON with the expected shape', async () => {
    const payload = {
      ok: true,
      count: 1,
      sessions: [
        {
          surface: 'tui',
          actorId: 'local',
          grantedAt: '2026-04-26T13:00:00.000Z',
          expiresAt: '2026-04-26T16:00:00.000Z',
          remainingMs: 10800000,
        },
      ],
      asOf: '2026-04-26T13:00:01.000Z',
    };
    mockFetchResolve(payload);

    await tierCommandHandler.handle(buildContext({ json: true }));

    const output = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      count: 1,
      sessions: [{ surface: 'tui', actorId: 'local' }],
    });
  });

  it('surfaces actionable error when daemon refuses connection', async () => {
    const err = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3100');
    mockFetchReject(err);

    await tierCommandHandler.handle(buildContext());

    const errOutput = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(errOutput).toContain('Memphis daemon is not running');
    expect(errOutput).toContain('systemctl --user start memphis');
  });

  it('maps 401 response to "check MEMPHIS_API_TOKEN" message', async () => {
    mockFetchResolve({ ok: false }, 401);

    await tierCommandHandler.handle(buildContext());

    const errOutput = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(errOutput).toContain('Unauthorized (401)');
    expect(errOutput).toContain('MEMPHIS_API_TOKEN');
  });

  it('rejects unknown subcommand with usage hint', async () => {
    await tierCommandHandler.handle(buildContext({ subcommand: 'bogus' }));

    const errOutput = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(errOutput).toContain('Unknown tier subcommand: bogus');
    expect(errOutput).toContain('Usage: memphis tier <status|revoke>');
  });
});

describe('memphis tier revoke', () => {
  it('revokes all sessions when called bare', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, revoked: 2, scope: 'all' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await tierCommandHandler.handle(buildContext({ subcommand: 'revoke' }));

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Revoked 2 tier-3 sessions');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(callBody).toEqual({ all: true });
  });

  it('revokes a specific surface+actor pair via flags', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, revoked: 1, surface: 'telegram', actorId: '12345' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await tierCommandHandler.handle(
      buildContext({
        subcommand: 'revoke',
        argv: ['--surface', 'telegram', '--actor', '12345'],
      }),
    );

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('surface=telegram actor=12345');

    const callBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(callBody).toEqual({ surface: 'telegram', actorId: '12345' });
  });

  it('errors when only one of --surface/--actor is supplied', async () => {
    await tierCommandHandler.handle(
      buildContext({ subcommand: 'revoke', argv: ['--surface', 'telegram'] }),
    );

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('--surface and --actor must be supplied together');
  });

  it('reports zero-revoked when no active sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, revoked: 0, scope: 'all' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await tierCommandHandler.handle(buildContext({ subcommand: 'revoke' }));

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('No active tier-3 sessions to revoke');
  });

  it('surfaces 404 when specific session is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: 'no active tier-3 session for surface=tui actorId=ghost',
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await tierCommandHandler.handle(
      buildContext({
        subcommand: 'revoke',
        argv: ['--surface', 'tui', '--actor', 'ghost'],
      }),
    );

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('no active tier-3 session');
  });

  it('actionable error when daemon refuses connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3100'))),
    );

    await tierCommandHandler.handle(buildContext({ subcommand: 'revoke' }));

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Memphis daemon is not running');
  });
});
