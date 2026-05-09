import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeCommand } from '../../src/infra/cli/dispatcher.js';
import { parseCommand } from '../../src/infra/cli/parser.js';

// Closure sprint Z.3.1 (2026-05-09): retired the `vi.doMock` +
// dynamic import dance that flapped on macOS-latest (#407). The
// dispatcher now accepts an optional registry factory as its 3rd
// argument; tests pass a stub registry directly, no module mocking.
// Linux always passed; macOS intermittently lost the mock-vs-import
// race. This shape tolerates both platforms by construction — there is
// no race left to lose.

const systemHandle = vi.fn(async () => false);
const embedHandle = vi.fn(async () => false);
const interactionHandle = vi.fn(async () => false);

type Registration = {
  name: string;
  commands: Array<string | undefined>;
  loadHandler: () => Promise<{
    name: string;
    commands: Array<string | undefined>;
    canHandle: () => boolean;
    handle: (...args: unknown[]) => Promise<boolean>;
  }>;
};

function buildRegistry(command?: string): Registration[] {
  const registrations = new Map<string | undefined, Registration[]>([
    [
      'help',
      [
        {
          name: 'system',
          commands: [undefined, 'help'],
          loadHandler: async () => ({
            name: 'system',
            commands: [undefined, 'help'],
            canHandle: () => true,
            handle: (...args: unknown[]) => systemHandle(...args),
          }),
        },
      ],
    ],
    [
      'embed',
      [
        {
          name: 'embed',
          commands: ['embed'],
          loadHandler: async () => ({
            name: 'embed',
            commands: ['embed'],
            canHandle: () => true,
            handle: (...args: unknown[]) => embedHandle(...args),
          }),
        },
      ],
    ],
    [
      'ask',
      [
        {
          name: 'interaction',
          commands: ['ask'],
          loadHandler: async () => ({
            name: 'interaction',
            commands: ['ask'],
            canHandle: () => true,
            handle: (...args: unknown[]) => interactionHandle(...args),
          }),
        },
      ],
    ],
  ]);

  return registrations.get(command) ?? [];
}

describe('CLI router dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes embed command through storage handlers', async () => {
    const argv = ['node', 'memphis', 'embed', 'search', '--query', 'test'];
    embedHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv), buildRegistry);

    expect(embedHandle).toHaveBeenCalledOnce();
  });

  it('routes help through system handler', async () => {
    const argv = ['node', 'memphis', 'help'];
    systemHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv), buildRegistry);

    expect(systemHandle).toHaveBeenCalledOnce();
  });

  it('routes ask through interaction handler (was the macOS-only #407 flap pre-Z.3.1)', async () => {
    const argv = ['node', 'memphis', 'ask', '--input', 'hello'];
    interactionHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv), buildRegistry);

    expect(interactionHandle).toHaveBeenCalledOnce();
  });

  it('falls back to the real registry when no override is passed (production wire)', async () => {
    // Sanity check: the optional 3rd arg defaults to
    // getCliCommandRegistrations, so omitting it must not throw and
    // must still dispatch (even if no real handler matches our junk
    // command, the function should reach the "unknown command" path
    // rather than failing earlier on a missing default).
    const argv = ['node', 'memphis', '__never_a_real_command__'];
    await expect(executeCommand(argv, parseCommand(argv))).rejects.toThrow(
      /Unknown command:|memphis __never_a_real_command__/,
    );
  });
});
