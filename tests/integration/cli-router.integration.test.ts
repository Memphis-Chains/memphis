import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const systemHandle = vi.fn(async () => false);
const embedHandle = vi.fn(async () => false);
const interactionHandle = vi.fn(async () => false);

function buildRegistryMock(command?: string) {
  const registrations = new Map<
    string | undefined,
    Array<{
      name: string;
      commands: Array<string | undefined>;
      loadHandler: () => Promise<{
        name: string;
        commands: Array<string | undefined>;
        canHandle: () => boolean;
        handle: (...args: unknown[]) => Promise<boolean>;
      }>;
    }>
  >([
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

async function importDispatcherWithMock() {
  vi.resetModules();
  vi.doMock('../../src/infra/cli/registry.js', () => ({
    getCliCommandRegistrations: (command?: string) => buildRegistryMock(command),
    listCliCompletionCommands: () => [],
  }));

  const [{ executeCommand }, { parseCommand }] = await Promise.all([
    import('../../src/infra/cli/dispatcher.js'),
    import('../../src/infra/cli/parser.js'),
  ]);
  return { executeCommand, parseCommand };
}

describe('CLI router dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock('../../src/infra/cli/registry.js');
    vi.resetModules();
  });

  it('routes embed command through storage handlers', async () => {
    const { executeCommand, parseCommand } = await importDispatcherWithMock();
    const argv = ['node', 'memphis', 'embed', 'search', '--query', 'test'];
    embedHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv));

    expect(embedHandle).toHaveBeenCalledOnce();
  });

  it('routes help through system handler', async () => {
    const { executeCommand, parseCommand } = await importDispatcherWithMock();
    const argv = ['node', 'memphis', 'help'];
    systemHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv));

    expect(systemHandle).toHaveBeenCalledOnce();
  });

  it('routes ask through interaction handler', async () => {
    const { executeCommand, parseCommand } = await importDispatcherWithMock();
    const argv = ['node', 'memphis', 'ask', '--input', 'hello'];
    interactionHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv));

    expect(interactionHandle).toHaveBeenCalledOnce();
  });
});
