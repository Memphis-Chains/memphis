import { describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../../src/infra/cli/context.js';
import {
  dispatchCommand,
  type CommandHandler,
} from '../../src/infra/cli/handlers/command-handler.js';

function contextFor(command?: string, subcommand?: string): CliContext {
  return {
    argv: [],
    args: {
      command,
      subcommand,
      json: false,
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
    },
    getConfig: vi.fn() as never,
    getContainer: vi.fn() as never,
  };
}

function createHandler(
  name: string,
  commands: Array<string | undefined>,
  canHandle: boolean,
  result: boolean,
): CommandHandler {
  return {
    name,
    commands,
    canHandle: vi.fn().mockReturnValue(canHandle),
    handle: vi.fn().mockResolvedValue(result),
  };
}

describe('CLI dispatcher routing', () => {
  it('routes only matching command candidates', async () => {
    const system = createHandler('system', [undefined, 'health'], true, true);
    const storage = createHandler('storage', ['chain'], true, true);

    const handled = await dispatchCommand(contextFor('health'), [system, storage]);

    expect(handled).toBe(true);
    expect(system.canHandle).toHaveBeenCalledOnce();
    expect(storage.canHandle).not.toHaveBeenCalled();
  });

  it('falls through handlers that share a command until one handles it', async () => {
    const system = createHandler('system', ['chain'], true, false);
    const storage = createHandler('storage', ['chain'], true, true);

    const handled = await dispatchCommand(contextFor('chain', 'import_json'), [system, storage]);

    expect(handled).toBe(true);
    expect(system.handle).toHaveBeenCalledOnce();
    expect(storage.handle).toHaveBeenCalledOnce();
  });
});
