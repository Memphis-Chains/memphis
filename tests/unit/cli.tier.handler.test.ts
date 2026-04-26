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
    expect(errOutput).toContain('Usage: memphis tier <status|elevate>');
  });
});

describe('memphis tier elevate', () => {
  const SAVED_PASS = process.env.MEMPHIS_OPERATOR_PASSPHRASE;

  beforeEach(() => {
    // Use the env-var path (no TTY needed in tests).
    process.env.MEMPHIS_OPERATOR_PASSPHRASE = 'CorrectOperatorPassphrase!';
  });
  afterEach(() => {
    if (SAVED_PASS === undefined) delete process.env.MEMPHIS_OPERATOR_PASSPHRASE;
    else process.env.MEMPHIS_OPERATOR_PASSPHRASE = SAVED_PASS;
  });

  it('elevates with default surface=cli + USER actor when flags omitted', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            tier: 3,
            session: {
              surface: 'cli',
              actorId: 'memphis',
              grantedAt: '2026-04-26T20:00:00.000Z',
              expiresAt: '2026-04-26T23:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await tierCommandHandler.handle(buildContext({ subcommand: 'elevate' }));

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Tier 3 granted for surface=cli');
    expect(out).toContain('Expires at: 2026-04-26T23:00:00');

    const callBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(callBody.surface).toBe('cli');
    expect(callBody.passphrase).toBe('CorrectOperatorPassphrase!');
    expect(typeof callBody.actorId).toBe('string');
  });

  it('passes --surface and --actor through when supplied', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            tier: 3,
            session: {
              surface: 'telegram',
              actorId: '12345',
              grantedAt: '2026-04-26T20:00:00.000Z',
              expiresAt: '2026-04-26T23:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await tierCommandHandler.handle(
      buildContext({
        subcommand: 'elevate',
        argv: ['--surface', 'telegram', '--actor', '12345'],
      }),
    );

    const callBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(callBody.surface).toBe('telegram');
    expect(callBody.actorId).toBe('12345');
  });

  it('reports 403 with reason when passphrase wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              reason: 'bad-passphrase',
              error: 'Invalid operator passphrase. Tier 3 requires the passphrase you set during `memphis init`.',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await tierCommandHandler.handle(buildContext({ subcommand: 'elevate' }));

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Tier-3 denied');
    expect(err).toContain('bad-passphrase');
    expect(process.exitCode).toBe(1);
  });

  it('actionable error when daemon refuses connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3100'))),
    );

    await tierCommandHandler.handle(buildContext({ subcommand: 'elevate' }));

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Memphis daemon is not running');
    expect(process.exitCode).toBe(1);
  });

  it('rejects too-short operator passphrase locally', async () => {
    process.env.MEMPHIS_OPERATOR_PASSPHRASE = 'short';
    await tierCommandHandler.handle(buildContext({ subcommand: 'elevate' }));
    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('at least 8 characters');
    expect(process.exitCode).toBe(1);
  });
});
