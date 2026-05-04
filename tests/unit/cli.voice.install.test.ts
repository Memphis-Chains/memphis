/**
 * `memphis voice install` — operator one-shot installer for the local
 * voice stack. Pins:
 *   1. The handler shells out via `bash scripts/voice-install.sh`.
 *   2. `--restart` and `--stop` are forwarded as positional args.
 *   3. Other argv tokens are NOT forwarded (no shell injection of stray
 *      flags into the installer script).
 *
 * Separate test file (instead of cli.voice.test.ts) because mocking
 * node:child_process requires static vi.mock at module-load time, and
 * cli.voice.test.ts uses vi.doMock for deferred adapter imports —
 * mixing the two patterns wedges the runner.
 */
import { describe, expect, it, vi } from 'vitest';

const spawnCalls: Array<[string, string[]]> = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawnCalls.push([bin, args]);
    return {
      on(event: string, cb: (code: number) => void) {
        if (event === 'exit') queueMicrotask(() => cb(0));
        return this;
      },
    };
  }),
}));

const { voiceCommandHandler } = await import('../../src/infra/cli/handlers/voice.handler.js');

interface FakeContext {
  argv: string[];
  args: { command: string; subcommand: string };
}

function ctx(argv: string[]): FakeContext {
  return {
    argv,
    args: { command: 'voice', subcommand: 'install' },
  };
}

describe('memphis voice install', () => {
  it('shells out to scripts/voice-install.sh via bash', async () => {
    spawnCalls.length = 0;
    const ok = await voiceCommandHandler.handle(ctx(['memphis', 'voice', 'install']) as never);
    expect(ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    const [bin, args] = spawnCalls[0]!;
    expect(bin).toBe('bash');
    expect(args[0]).toMatch(/scripts\/voice-install\.sh$/);
    expect(args).toHaveLength(1); // no passthrough on plain install
  });

  it('forwards --restart to the installer', async () => {
    spawnCalls.length = 0;
    await voiceCommandHandler.handle(
      ctx(['memphis', 'voice', 'install', '--restart']) as never,
    );
    const [, args] = spawnCalls[0]!;
    expect(args).toContain('--restart');
  });

  it('forwards --stop to the installer', async () => {
    spawnCalls.length = 0;
    await voiceCommandHandler.handle(ctx(['memphis', 'voice', 'install', '--stop']) as never);
    const [, args] = spawnCalls[0]!;
    expect(args).toContain('--stop');
  });

  it('does NOT forward unrecognized flags (no shell injection)', async () => {
    spawnCalls.length = 0;
    await voiceCommandHandler.handle(
      ctx(['memphis', 'voice', 'install', '--rm', '-rf', '/']) as never,
    );
    const [, args] = spawnCalls[0]!;
    expect(args).toHaveLength(1);
    expect(args).not.toContain('--rm');
    expect(args).not.toContain('-rf');
    expect(args).not.toContain('/');
  });

  it('forwards --voice <known> to the installer', async () => {
    spawnCalls.length = 0;
    await voiceCommandHandler.handle(
      ctx(['memphis', 'voice', 'install', '--voice', 'darkman']) as never,
    );
    const [, args] = spawnCalls[0]!;
    expect(args).toContain('--voice');
    expect(args).toContain('darkman');
  });

  it('accepts --voice=<known> shorthand', async () => {
    spawnCalls.length = 0;
    await voiceCommandHandler.handle(
      ctx(['memphis', 'voice', 'install', '--voice=gosia']) as never,
    );
    const [, args] = spawnCalls[0]!;
    expect(args).toContain('--voice');
    expect(args).toContain('gosia');
  });

  it('rejects unknown voice without launching the installer', async () => {
    spawnCalls.length = 0;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await voiceCommandHandler.handle(
      ctx(['memphis', 'voice', 'install', '--voice', 'bogus']) as never,
    );
    expect(spawnCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).toContain('unknown voice "bogus"');
    expect(stderr).toMatch(/Known: .*gosia/);
    expect(stderr).toMatch(/Known: .*darkman/);
    stderrSpy.mockRestore();
    process.exitCode = 0;
  });

  it('combines --restart and --voice in one passthrough', async () => {
    spawnCalls.length = 0;
    await voiceCommandHandler.handle(
      ctx(['memphis', 'voice', 'install', '--restart', '--voice', 'darkman']) as never,
    );
    const [, args] = spawnCalls[0]!;
    expect(args).toContain('--restart');
    expect(args).toContain('--voice');
    expect(args).toContain('darkman');
  });
});
