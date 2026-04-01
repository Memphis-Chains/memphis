import { afterEach, describe, expect, it, vi } from 'vitest';

const { runTurnRuntime } = vi.hoisted(() => ({
  runTurnRuntime: vi.fn(async () => ({
    provider: 'local-fallback',
    model: 'local-fallback-v0',
    timingMs: 5,
    output: 'hello ask from memphis',
    messages: [],
    persistence: {
      sessionUpdated: true,
      memoryStoreAttempted: false,
      memoryStored: false,
      postResponseCognitiveAttempted: false,
      postResponseCognitiveOk: false,
      degraded: false,
      errors: [],
    },
  })),
}));

vi.mock('../../src/gateway/turn-runtime.js', () => ({ runTurnRuntime }));
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

import { handleInteractionCommand } from '../../src/infra/cli/commands/interaction.js';
import type { CliContext } from '../../src/infra/cli/context.js';
import type { CliArgs } from '../../src/infra/cli/types.js';
import { printDoctorHumanV2, runDoctorChecksV2 } from '../../src/infra/cli/utils/doctor-v2.js';

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
});

describe('CLI ask + doctor', () => {
  it('supports ask alias with JSON output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const context = {
      argv: [],
      args: baseArgs({ command: 'ask', input: 'hello ask', json: true }),
      getConfig: () => ({ DEFAULT_PROVIDER: 'local-fallback' }),
      getContainer: () => {
        const mockProvider = {
          name: 'local-fallback',
          isConfigured: () => true,
          isAvailable: async () => true,
          listModels: async () => ['local-fallback-v0'],
          defaultModel: () => 'local-fallback-v0',
          chat: vi.fn(),
          generate: vi.fn(),
        };
        return {
          orchestration: {
            generate: vi.fn().mockResolvedValue({
              id: 'gen_1',
              providerUsed: 'local-fallback',
              output: 'hello ask from memphis',
              timingMs: 5,
            }),
            resolveRuntimeProvider: vi.fn(() => mockProvider),
            getCascadeResult: vi.fn(() => ({
              provider: mockProvider,
              degraded: false,
              tier: 1 as const,
              originalRequested: 'auto',
              actualProvider: 'local-fallback',
            })),
          },
        } as never;
      },
    } satisfies CliContext;

    const handled = await handleInteractionCommand(context);

    expect(handled).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const payload = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(payload.providerUsed).toBe('local-fallback');
    expect(payload.output).toContain('hello ask');
  });

  it('doctor reports enhanced checks in JSON shape', async () => {
    const data = await runDoctorChecksV2();
    const ids = data.checks.map((check) => check.id);

    expect(data).toHaveProperty('ok');
    expect(ids).toContain('node-version');
    expect(ids).toContain('rust-toolchain');
    expect(ids).toContain('ollama');
    expect(ids).toContain('t1-home-dir');
    expect(ids).toContain('t1-chain-integrity');
    expect(ids).toContain('t1-chain-memory-source');
    expect(ids).toContain('t1-first-run-contract');
    expect(ids).toContain('t1-exact-search-state');
    expect(ids).toContain('t1-recall-mode');
    expect(ids).toContain('t1-cognitive-persistence');
    expect(ids).toContain('t1-vault-cycle');
    expect(ids).toContain('t2-offline-runtime-mode');
    expect(ids).toContain('t2-provider-latency');
    expect(ids).toContain('t4-chat-surface-hardening');
    expect(ids).toContain('t4-chat-surface-exposure');
    expect(ids).toContain('t6-mcp-server');
    expect(['healthy', 'degraded-repairable', 'degraded-manual']).toContain(data.repairStatus);
    expect(typeof data.repairable).toBe('boolean');
    expect(typeof data.recommendedAction).toBe('string');
    expect(data.firstRunPlan).toEqual(
      expect.objectContaining({
        nextCommand: expect.any(String),
      }),
    );
  }, 15000);

  it('doctor prints human-readable output with indicators', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const report = await runDoctorChecksV2();

    printDoctorHumanV2(report);

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('MEMPHIS DOCTOR v2.0');
    expect(/✓|✗|⚠/.test(output)).toBe(true);
    expect(output).toContain('Repair: status=');
    expect(output).toContain('First-run plan:');
  });
});
