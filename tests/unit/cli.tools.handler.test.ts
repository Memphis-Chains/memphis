/**
 * Unit tests for `memphis tools list/describe` CLI handler (S3).
 *
 * Mirrors the shape of `cli.tier.handler.test.ts` (PR #282). Mocks global
 * `fetch` to drive every code path without standing up a daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { toolsCommandHandler } from '../../src/infra/cli/handlers/tools.handler.js';

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

const samplePayload = {
  surface: 'cli',
  surfacePolicy: { maxToolTier: 2 },
  effectiveTier: 2 as const,
  cognitive: { mode: 'A', name: 'ConsciousCapture' },
  tools: [
    {
      name: 'memphis_journal',
      tier: 0 as const,
      capabilities: ['write'],
      description: 'Save entries to journal chain',
      featureFlag: null,
      available: true,
    },
    {
      name: 'memphis_self_describe',
      tier: 0 as const,
      capabilities: ['read'],
      description: 'Runtime self-introspection',
      featureFlag: null,
      available: true,
    },
    {
      name: 'memphis_exec',
      tier: 2 as const,
      capabilities: ['execute'],
      description: 'Run a command',
      featureFlag: null,
      available: true,
    },
  ],
  toolsAvailable: 3,
  toolsRegistered: 3,
  featureFlags: [],
  asOf: '2026-04-26T16:00:00.000Z',
};

function buildContext(opts: {
  argv?: string[];
  json?: boolean;
  subcommand?: string;
  target?: string;
} = {}): CliContext {
  return {
    argv: opts.argv ?? [],
    args: {
      command: 'tools',
      subcommand: opts.subcommand ?? 'list',
      target: opts.target,
      json: opts.json ?? false,
    } as CliContext['args'],
    getConfig: () =>
      ({
        HOST: '127.0.0.1',
        PORT: 3100,
        MEMPHIS_API_TOKEN: 'test-token',
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

describe('memphis tools list', () => {
  it('renders the surface header + tools by tier', async () => {
    mockFetchResolve(samplePayload);
    await toolsCommandHandler.handle(buildContext());

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Surface: cli');
    expect(out).toContain('cognitive mode: A (ConsciousCapture)');
    expect(out).toContain('Tools: 3/3 available');
    expect(out).toContain('tier 0:');
    expect(out).toContain('memphis_journal');
    expect(out).toContain('memphis_self_describe');
    expect(out).toContain('tier 2:');
    expect(out).toContain('memphis_exec');
  });

  it('respects --tier 0 filter via argv', async () => {
    mockFetchResolve(samplePayload);
    await toolsCommandHandler.handle(buildContext({ argv: ['--tier', '0'] }));

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('tier 0:');
    expect(out).not.toContain('tier 2:');
    expect(out).not.toContain('memphis_exec');
  });

  it('--json emits parseable shape', async () => {
    mockFetchResolve(samplePayload);
    await toolsCommandHandler.handle(buildContext({ json: true }));

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(out);
    expect(parsed.surface).toBe('cli');
    expect(parsed.tools).toHaveLength(3);
  });

  it('actionable error when daemon refuses connection', async () => {
    mockFetchReject(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3100'));
    await toolsCommandHandler.handle(buildContext());

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Memphis daemon is not running');
    expect(err).toContain('systemctl --user start memphis');
  });

  it('maps 401 to MEMPHIS_API_TOKEN message', async () => {
    mockFetchResolve({ ok: false }, 401);
    await toolsCommandHandler.handle(buildContext());

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Unauthorized (401)');
    expect(err).toContain('MEMPHIS_API_TOKEN');
  });
});

describe('memphis tools describe', () => {
  it('prints structured detail for known tool', async () => {
    mockFetchResolve(samplePayload);
    await toolsCommandHandler.handle(
      buildContext({ subcommand: 'describe', target: 'memphis_self_describe' }),
    );

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Tool:         memphis_self_describe');
    expect(out).toContain('Tier:         0');
    expect(out).toContain('Available:    yes');
    expect(out).toContain('Runtime self-introspection');
  });

  it('--json emits a single tool object', async () => {
    mockFetchResolve(samplePayload);
    await toolsCommandHandler.handle(
      buildContext({ subcommand: 'describe', target: 'memphis_journal', json: true }),
    );

    const out = consoleSpy.log.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(out);
    expect(parsed.name).toBe('memphis_journal');
  });

  it('errors on unknown tool name', async () => {
    mockFetchResolve(samplePayload);
    await toolsCommandHandler.handle(
      buildContext({ subcommand: 'describe', target: 'memphis_bogus' }),
    );

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Tool not found');
    expect(err).toContain('memphis_bogus');
  });

  it('rejects missing target with usage hint', async () => {
    await toolsCommandHandler.handle(buildContext({ subcommand: 'describe' }));

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Usage: memphis tools describe');
  });
});

describe('memphis tools subcommand dispatch', () => {
  it('rejects unknown subcommand with usage hint', async () => {
    await toolsCommandHandler.handle(buildContext({ subcommand: 'bogus' }));

    const err = consoleSpy.error.mock.calls.map((c) => c[0]).join('\n');
    expect(err).toContain('Unknown tools subcommand: bogus');
    expect(err).toContain('Usage: memphis tools <list|describe>');
  });
});
