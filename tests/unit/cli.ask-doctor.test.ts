import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleInteractionCommand } from '../../src/infra/cli/commands/interaction.js';
import { printDoctorHumanV2, runDoctorChecksV2 } from '../../src/infra/cli/utils/doctor-v2.js';
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
      getContainer: () =>
        ({
          orchestration: {
            generate: vi.fn().mockResolvedValue({
              id: 'gen_1',
              providerUsed: 'local-fallback',
              output: 'hello ask from memphis',
              timingMs: 5,
            }),
          },
        }) as never,
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
    expect(ids).toContain('t1-vault-cycle');
    expect(ids).toContain('t2-provider-latency');
    expect(ids).toContain('t6-mcp-server');
  });

  it('doctor prints human-readable output with indicators', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const report = await runDoctorChecksV2();

    printDoctorHumanV2(report);

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('MEMPHIS DOCTOR v2.0');
    expect(/✓|✗|⚠/.test(output)).toBe(true);
  });
});
