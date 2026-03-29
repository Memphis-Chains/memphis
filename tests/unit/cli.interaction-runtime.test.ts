/**
 * Tests for CLI interaction command runtime convergence.
 * Proves that supported CLI chat flows use the canonical turn runtime
 * and that provider-only mode uses orchestration.generate explicitly.
 */

import { describe, expect, it, vi } from 'vitest';

const { runTurnRuntime } = vi.hoisted(() => ({
  runTurnRuntime: vi.fn(async () => ({
    provider: 'local-fallback',
    model: 'local-fallback-v0',
    timingMs: 5,
    output: 'canonical reply',
    messages: [],
    persistence: {
      sessionUpdated: true,
      memoryStoreAttempted: true,
      memoryStored: true,
      postResponseCognitiveAttempted: true,
      postResponseCognitiveOk: true,
      degraded: false,
      errors: [],
    },
  })),
}));

vi.mock('../../src/gateway/turn-runtime.js', () => ({
  runTurnRuntime,
}));

vi.mock('../../src/gateway/agent-runtime.js', () => ({
  buildRuntimeSystemPrompt: () => 'system prompt',
}));

vi.mock('../../src/gateway/memory-client.js', () => ({
  createInProcessMemoryClient: () => ({
    recall: vi.fn(async () => ({ items: [] })),
    store: vi.fn(async () => undefined),
    isAvailable: vi.fn(() => true),
  }),
}));

vi.mock('../../src/gateway/tool-executor.js', () => ({
  createInProcessToolExecutor: () => ({
    listTools: () => [],
    execute: vi.fn(async () => '{}'),
  }),
}));

vi.mock('../../src/infra/storage/case-chain-adapter.js', () => ({
  CaseChainAdapter: class {
    constructor() {}
  },
}));

import { handleInteractionCommand } from '../../src/infra/cli/commands/interaction.js';

function makeContext(overrides: {
  command: string;
  input?: string;
  providerOnly?: boolean;
  interactive?: boolean;
}) {
  const generateMock = vi.fn(async () => ({
    id: 'gen_1',
    providerUsed: 'local-fallback',
    modelUsed: 'local-fallback-v0',
    output: 'provider-only reply',
    timingMs: 3,
  }));

  const mockProvider = {
    name: 'local-fallback' as const,
    isConfigured: () => true,
    isAvailable: async () => true,
    listModels: async () => ['local-fallback-v0'],
    defaultModel: () => 'local-fallback-v0',
    healthCheck: async () => ({ name: 'local-fallback' as const, ok: true }),
    chat: vi.fn(),
    generate: vi.fn(),
  };

  const resolveRuntimeProvider = vi.fn(() => mockProvider);

  const getCascadeResult = vi.fn(() => ({
    provider: mockProvider,
    degraded: false,
    tier: 1 as const,
    originalRequested: 'auto',
    actualProvider: 'local-fallback',
  }));

  return {
    context: {
      args: {
        command: overrides.command,
        input: overrides.input,
        providerOnly: overrides.providerOnly ?? false,
        interactive: overrides.interactive ?? false,
        json: true,
        tui: false,
        provider: 'auto',
        model: undefined,
        strategy: undefined,
        session: undefined,
        systemPrompt: undefined,
      },
      getContainer: () => ({
        orchestration: {
          generate: generateMock,
          resolveRuntimeProvider,
          getCascadeResult,
          providersHealth: vi.fn(async () => []),
        },
        evolveSessionRepository: {},
      }),
      getConfig: () => ({ DEFAULT_PROVIDER: 'local-fallback' }),
    },
    mocks: { generateMock, resolveRuntimeProvider, getCascadeResult },
  };
}

describe('CLI interaction runtime convergence', () => {
  it('canonical mode: chat uses runTurnRuntime via runChatTurn', async () => {
    runTurnRuntime.mockClear();
    const { context, mocks } = makeContext({ command: 'chat', input: 'hello' });

    await handleInteractionCommand(context as never);

    expect(runTurnRuntime).toHaveBeenCalled();
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });

  it('canonical mode: ask uses runTurnRuntime via runChatTurn', async () => {
    runTurnRuntime.mockClear();
    const { context, mocks } = makeContext({ command: 'ask', input: 'hello' });

    await handleInteractionCommand(context as never);

    expect(runTurnRuntime).toHaveBeenCalled();
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });

  it('canonical mode: cascade gracefully handles provider cooldown', async () => {
    runTurnRuntime.mockClear();
    const { context, mocks } = makeContext({ command: 'chat', input: 'hello' });

    // Mock cascade returning degraded tier 2
    const degradedMockProvider = {
      name: 'ollama' as const,
      isConfigured: () => true,
      isAvailable: async () => true,
      listModels: async () => ['qwen2.5:3b'],
      defaultModel: () => 'qwen2.5:3b',
      healthCheck: async () => ({ name: 'ollama' as const, ok: true }),
      chat: vi.fn(),
      generate: vi.fn(),
    };

    (mocks.getCascadeResult as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      provider: degradedMockProvider,
      degraded: true,
      tier: 2 as const,
      originalRequested: 'deepseek',
      actualProvider: 'ollama',
      reason: 'deepseek in cooldown',
    }));

    // Should NOT throw - cascade handles it
    await handleInteractionCommand(context as never);

    expect(runTurnRuntime).toHaveBeenCalled();
    expect(mocks.getCascadeResult).toHaveBeenCalled();
  });

  it('provider-only mode: uses orchestration.generate, not runTurnRuntime', async () => {
    runTurnRuntime.mockClear();
    const { context, mocks } = makeContext({
      command: 'chat',
      input: 'hello',
      providerOnly: true,
    });

    await handleInteractionCommand(context as never);

    expect(mocks.generateMock).toHaveBeenCalled();
    expect(runTurnRuntime).not.toHaveBeenCalled();
  });
});
