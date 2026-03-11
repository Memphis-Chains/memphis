import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCommand } from '../../src/infra/cli/dispatcher.js';
import { parseCommand } from '../../src/infra/cli/parser.js';

const systemSpy = vi.fn(async () => false);
const storageSpy = vi.fn(async () => false);
const interactionSpy = vi.fn(async () => false);

vi.mock('../../src/infra/cli/commands/system.js', () => ({
  handleSystemCommand: (...args: unknown[]) => systemSpy(...args),
}));

vi.mock('../../src/infra/cli/commands/storage.js', () => ({
  handleStorageCommand: (...args: unknown[]) => storageSpy(...args),
}));

vi.mock('../../src/infra/cli/commands/interaction.js', () => ({
  handleInteractionCommand: (...args: unknown[]) => interactionSpy(...args),
}));

describe('CLI router dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('routes embed command through storage handlers', async () => {
    const args = parseCommand(['node', 'memphis', 'embed', 'search', '--query', 'test']);
    storageSpy.mockResolvedValueOnce(true);

    await executeCommand(['node', 'memphis', 'embed', 'search', '--query', 'test'], args);

    expect(storageSpy).toHaveBeenCalledOnce();
  });

  it('routes help through system handler', async () => {
    const args = parseCommand(['node', 'memphis', 'help']);
    systemSpy.mockResolvedValueOnce(true);

    await executeCommand(['node', 'memphis', 'help'], args);

    expect(systemSpy).toHaveBeenCalledOnce();
  });

  it('routes ask through interaction handler', async () => {
    const args = parseCommand(['node', 'memphis', 'ask', '--input', 'hello']);
    interactionSpy.mockResolvedValueOnce(true);

    await executeCommand(['node', 'memphis', 'ask', '--input', 'hello'], args);

    expect(interactionSpy).toHaveBeenCalledOnce();
  });
});
