import { afterEach, describe, expect, it, vi } from 'vitest';

const { resolveRuntimeProviderMock, runChatTurnMock, buildRuntimeSystemPromptMock } = vi.hoisted(
  () => ({
    resolveRuntimeProviderMock: vi.fn(),
    runChatTurnMock: vi.fn(),
    buildRuntimeSystemPromptMock: vi.fn(() => 'memphis-system-prompt'),
  }),
);

vi.mock('../../src/infra/cli/chat-turn.js', () => ({
  runChatTurn: runChatTurnMock,
}));

vi.mock('../../src/gateway/agent-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/gateway/agent-runtime.js')>(
    '../../src/gateway/agent-runtime.js',
  );
  return {
    ...actual,
    buildRuntimeSystemPrompt: buildRuntimeSystemPromptMock,
  };
});

import { handleInteractionCommand } from '../../src/infra/cli/commands/interaction.js';
import type { CliContext } from '../../src/infra/cli/context.js';
import type { CliArgs } from '../../src/infra/cli/types.js';

function baseArgs(overrides: Partial<CliArgs>): CliArgs {
  return {
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
    safeMode: false,
    strictMode: false,
    providerOnly: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resolveRuntimeProviderMock.mockReset();
  runChatTurnMock.mockReset();
  buildRuntimeSystemPromptMock.mockClear();
});

describe('CLI agent runtime', () => {
  it('uses chat provider runtime for ollama chat command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const generate = vi.fn();
    const mockProvider = {
      name: 'ollama',
      isConfigured: () => true,
      isAvailable: async () => true,
      listModels: async () => ['qwen2.5-coder:3b'],
      defaultModel: () => 'qwen2.5-coder:3b',
      chat: vi.fn(),
    };
    resolveRuntimeProviderMock.mockReturnValue(mockProvider);
    runChatTurnMock.mockResolvedValue({
      provider: 'ollama',
      model: 'qwen2.5-coder:3b',
      timingMs: 14,
      output: 'rich runtime reply',
    });

    const getCascadeResultMock = vi.fn(() => ({
      provider: mockProvider,
      degraded: false,
      tier: 1 as const,
      originalRequested: 'ollama',
      actualProvider: 'ollama',
    }));

    const context = {
      argv: [],
      args: baseArgs({ command: 'chat', input: 'hello', provider: 'ollama', json: true }),
      getConfig: () => ({ DEFAULT_PROVIDER: 'local-fallback' }),
      getContainer: () =>
        ({
          orchestration: {
            generate,
            resolveRuntimeProvider: resolveRuntimeProviderMock,
            getCascadeResult: getCascadeResultMock,
          },
        }) as never,
    } satisfies CliContext;

    const handled = await handleInteractionCommand(context);

    expect(handled).toBe(true);
    expect(getCascadeResultMock).toHaveBeenCalledOnce();
    expect(runChatTurnMock).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(payload.providerUsed).toBe('ollama');
    expect(payload.output).toBe('rich runtime reply');
  });

  it('uses orchestration.generate for provider-only mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const generate = vi.fn().mockResolvedValue({
      id: 'gen_1',
      providerUsed: 'local-fallback',
      output: 'provider-only reply',
      timingMs: 5,
    });

    const context = {
      argv: [],
      args: baseArgs({
        command: 'chat',
        input: 'hello',
        provider: 'auto',
        json: true,
        providerOnly: true,
      }),
      getConfig: () => ({ DEFAULT_PROVIDER: 'local-fallback' }),
      getContainer: () =>
        ({
          orchestration: {
            generate,
          },
        }) as never,
    } satisfies CliContext;

    const handled = await handleInteractionCommand(context);

    expect(handled).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(resolveRuntimeProviderMock).not.toHaveBeenCalled();
    expect(runChatTurnMock).not.toHaveBeenCalled();
    const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(payload.providerUsed).toBe('local-fallback');
    expect(payload.output).toBe('provider-only reply');
    expect(payload.mode).toBe('provider-only');
  });
});
