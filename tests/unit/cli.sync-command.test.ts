import { describe, expect, it, vi } from 'vitest';

import { handleSyncCommand } from '../../src/infra/cli/commands/sync.js';
import type { CliContext } from '../../src/infra/cli/context.js';

const { statusMock, pushMock, pullMock } = vi.hoisted(() => ({
  statusMock: vi.fn(() => ({ chain: 'journal', pending: 0 })),
  pushMock: vi.fn(async () => ({ pushed: 0 })),
  pullMock: vi.fn(async () => ({ pulled: 0 })),
}));

vi.mock('../../src/sync/sync-manager.js', () => ({
  SyncManager: class {
    status = statusMock;
    push = pushMock;
    pull = pullMock;
  },
}));

vi.mock('../../src/infra/cli/utils/render.js', () => ({
  print: vi.fn(),
}));

function contextFor(command: string, subcommand: string): CliContext {
  return {
    argv: [],
    args: {
      command,
      subcommand,
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
      list: false,
      clean: false,
      chain: 'journal',
    },
    getConfig: vi.fn() as never,
    getContainer: vi.fn() as never,
  };
}

describe('CLI sync command', () => {
  it('accepts the legacy network alias and routes it through sync status', async () => {
    const handled = await handleSyncCommand(contextFor('network', 'status'));

    expect(handled).toBe(true);
    expect(statusMock).toHaveBeenCalledWith('journal');
    expect(pushMock).not.toHaveBeenCalled();
    expect(pullMock).not.toHaveBeenCalled();
  });
});
