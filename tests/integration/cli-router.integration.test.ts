import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeCommand } from '../../src/infra/cli/dispatcher.js';
import { parseCommand } from '../../src/infra/cli/parser.js';

const systemHandle = vi.fn(async () => false);
const embedHandle = vi.fn(async () => false);
const interactionHandle = vi.fn(async () => false);

vi.mock('../../src/infra/cli/handlers/system.handler.js', () => ({
  systemCommandHandler: {
    name: 'system',
    commands: [undefined, 'help'],
    canHandle: vi.fn(() => true),
    handle: (...args: unknown[]) => systemHandle(...args),
  },
}));

vi.mock('../../src/infra/cli/handlers/embed.handler.js', () => ({
  embedCommandHandler: {
    name: 'embed',
    commands: ['embed'],
    canHandle: vi.fn(() => true),
    handle: (...args: unknown[]) => embedHandle(...args),
  },
}));

vi.mock('../../src/infra/cli/handlers/interaction.handler.js', () => ({
  interactionCommandHandler: {
    name: 'interaction',
    commands: ['ask'],
    canHandle: vi.fn(() => true),
    handle: (...args: unknown[]) => interactionHandle(...args),
  },
}));

describe('CLI router dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes embed command through storage handlers', async () => {
    const argv = ['node', 'memphis', 'embed', 'search', '--query', 'test'];
    embedHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv));

    expect(embedHandle).toHaveBeenCalledOnce();
  });

  it('routes help through system handler', async () => {
    const argv = ['node', 'memphis', 'help'];
    systemHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv));

    expect(systemHandle).toHaveBeenCalledOnce();
  });

  it('routes ask through interaction handler', async () => {
    const argv = ['node', 'memphis', 'ask', '--input', 'hello'];
    interactionHandle.mockResolvedValueOnce(true);

    await executeCommand(argv, parseCommand(argv));

    expect(interactionHandle).toHaveBeenCalledOnce();
  });
});
