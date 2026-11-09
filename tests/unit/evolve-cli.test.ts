import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { evolveCommandHandler } from '../../src/infra/cli/handlers/evolve.handler.js';
import type { CliArgs } from '../../src/infra/cli/types.js';

const rollbackMock = vi.fn();
const rollbackCtorMock = vi.fn();
const listSnapshotsMock = vi.fn();

vi.mock('../../src/backup/rollback.js', () => ({
  RollbackManager: class {
    constructor(dataDir: string) {
      rollbackCtorMock(dataDir);
    }

    rollback(snapshotId: string) {
      return rollbackMock(snapshotId);
    }

    listSnapshots() {
      return listSnapshotsMock();
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
    listSnapshotsMock.mockReset();
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rolls back a session with snapshot metadata through RollbackManager', async () => {
    listSnapshotsMock.mockResolvedValue([]);
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
    listSnapshotsMock.mockResolvedValue([]);
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

  it.each(['exact', 'prefix'])('refuses snapshot restore for an interrupted isolated worktree (%s lookup)', async (lookup) => {
    const session = { id: 'sess-12345678', snapshotId: 'snapshot-1', status: 'active',
      intent: 'prepare runtime', branch: 'evolve/review-sess-12345678' };
    const repo = {
      getById: vi.fn().mockReturnValue(lookup === 'exact' ? session : null),
      listRecent: vi.fn().mockReturnValue([session]),
      updateStatus: vi.fn(),
    };
    const context = makeContext(repo);
    if (lookup === 'prefix') context.args.target = 'sess-123';
    await expect(evolveCommandHandler.handle(context)).rejects.toThrow('isolated evolution cannot be restored');
    expect(rollbackCtorMock).not.toHaveBeenCalled();
    expect(rollbackMock).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('refuses snapshot restore for a persisted review even if its branch name differs', async () => {
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 'sess-12345678', snapshotId: 'snapshot-1',
        status: 'committed', intent: 'prepare runtime', branch: 'evolve/other' }),
      listRecent: vi.fn(), updateStatus: vi.fn(), reviewStore: () => ({ get: () => ({ status: 'prepared' }) }),
    };
    await expect(evolveCommandHandler.handle(makeContext(repo))).rejects.toThrow('isolated evolution cannot be restored');
    expect(rollbackMock).not.toHaveBeenCalled();
  });

  it('reports snapshot availability in evolve status json output', async () => {
    listSnapshotsMock.mockResolvedValue([
      {
        id: 'snapshot-1',
        timestamp: Date.now(),
        description: 'pre-change',
        version: 2,
      },
    ]);

    const repo = {
      getById: vi.fn(),
      listRecent: vi.fn().mockReturnValue([
        {
          id: 'sess-12345678',
          snapshotId: 'snapshot-1',
          status: 'active',
          intent: 'update runtime',
          branch: 'evolve/123',
          committedHash: null,
          errorMessage: null,
          createdAt: '2026-03-26T10:00:00.000Z',
        },
      ]),
      updateStatus: vi.fn(),
    };

    const context = {
      ...makeContext(repo),
      args: makeArgs({ subcommand: 'status' }),
    } satisfies CliContext;

    const handled = await evolveCommandHandler.handle(context);

    expect(handled).toBe(true);
    expect(listSnapshotsMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0])) as Array<{
      id: string;
      snapshotState: string;
    }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: 'sess-12345678',
      snapshotState: 'available',
    });
  });
});
