import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

import { runRustTui } from '../../src/infra/cli/commands/rust-tui.js';

function childThatExits(code = 0): EventEmitter {
  const emitter = new EventEmitter();
  queueMicrotask(() => emitter.emit('exit', code, null));
  return emitter;
}

describe('runRustTui', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset();
  });

  it('uses an existing compiled binary when present', async () => {
    existsSyncMock.mockReturnValueOnce(true);
    spawnMock.mockReturnValueOnce(childThatExits());

    await runRustTui({
      argv: ['node', 'memphis', 'tui'],
      args: {} as never,
      getConfig: () =>
        ({
          HOST: '127.0.0.1',
          PORT: 3000,
        }) as never,
      getContainer: vi.fn() as never,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0];
    expect(String(command)).toContain('memphis-tui');
    expect(args).toEqual([]);
  });

  it('falls back to cargo without injecting legacy HTTP env', async () => {
    existsSyncMock.mockReturnValue(false);
    spawnMock.mockReturnValueOnce(childThatExits());

    await runRustTui({
      argv: ['node', 'memphis', 'tui'],
      args: {} as never,
      getConfig: () =>
        ({
          HOST: '0.0.0.0',
          PORT: 4123,
          MEMPHIS_API_TOKEN: 'vault-token',
        }) as never,
      getContainer: vi.fn() as never,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe('cargo');
    expect(args).toEqual(['run', '--quiet', '-p', 'memphis-tui', '--']);
    expect(options.env.MEMPHIS_TUI_BASE_URL).toBeUndefined();
    expect(options.env.MEMPHIS_TUI_API_TOKEN).toBeUndefined();
  });
});
