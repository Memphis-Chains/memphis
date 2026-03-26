import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { evolveCommandHandler } from '../../src/infra/cli/handlers/evolve.handler.js';
import type { CliArgs } from '../../src/infra/cli/types.js';

const rollbackMock = vi.fn();
const rollbackCtorMock = vi.fn();

vi.mock('../../src/backup/rollback.js', () => ({
  RollbackManager: class {
    constructor(dataDir: string) {
      rollbackCtorMock(dataDir);
    }

    rollback(snapshotId: string) {
      return rollbackMock(snapshotId);
    }
  },
}));

vi.mock('../../src/config/paths.js', () => ({
  getDataDir: vi.fn(() => '/tmp/memphis-evolve-test'),
}));

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    command: 'evolve',
    subcommand: 'rollback',
    target: 'sess-12345678',
    json: true,
    tui: false,
    write: false,
    save: false,
    confirmWrite: false,
    interactive: false,
    nonInteractive: false,
    force: false,
    apply: false,
    dryRun: false,
    yes: false,
    schema: false,
    verbose: false,
    vision: false,
    functions: false,
    reset: false,
    runtime: false,
    list: false,
    clean: false,
    safeMode: false,
    strictMode: false,
    ...overrides,
  };
}

function makeContext(repo: {
  getById: ReturnType<typeof vi.fn>;
  listRecent: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
}): CliContext {
  return {
    argv: ['evolve', 'rollback', 'sess-12345678'],
    args: makeArgs(),
    getConfig: () => {
      throw new Error('not needed');
    },
    getContainer: () => ({ evolveSessionRepository: repo }) as never,
  };
}

describe('evolve CLI handler', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    rollbackMock.mockReset();
    rollbackCtorMock.mockReset();
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rolls back a session with snapshot metadata through RollbackManager', async () => {
    rollbackMock.mockResolvedValue({
      success: true,
      snapshotId: 'snapshot-1',
      timestamp: new Date().toISOString(),
    });
    const repo = {
      getById: vi.fn().mockReturnValue({
        id: 'sess-12345678',
        snapshotId: 'snapshot-1',
        status: 'active',
        intent: 'update runtime',
      }),
      listRecent: vi.fn(),
      updateStatus: vi.fn(),
    };

    const handled = await evolveCommandHandler.handle(makeContext(repo));

    expect(handled).toBe(true);
    expect(rollbackCtorMock).toHaveBeenCalledWith('/tmp/memphis-evolve-test');
    expect(rollbackMock).toHaveBeenCalledWith('snapshot-1');
    expect(repo.updateStatus).toHaveBeenCalledWith('sess-12345678', 'rolled-back', {
      errorMessage: 'manual rollback via CLI',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      JSON.stringify({ rolledBack: true, sessionId: 'sess-12345678' }, null, 2),
    );
  });

  it('refuses rollback when the session has no snapshot id', async () => {
    const repo = {
      getById: vi.fn().mockReturnValue({
        id: 'sess-12345678',
        snapshotId: null,
        status: 'active',
        intent: 'update runtime',
      }),
      listRecent: vi.fn(),
      updateStatus: vi.fn(),
    };

    const handled = await evolveCommandHandler.handle(makeContext(repo));

    expect(handled).toBe(true);
    expect(rollbackMock).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Session sess-123 has no snapshot to rollback to.',
    );
  });
});
