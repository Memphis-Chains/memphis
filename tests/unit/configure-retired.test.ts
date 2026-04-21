import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleConfigureCommand } from '../../src/infra/cli/commands/configure.js';
import type { CliContext } from '../../src/infra/cli/context.js';

const exitCodeSnapshot = () => process.exitCode;

describe('memphis configure (retired)', () => {
  let savedExitCode: number | string | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('returns handled=true AND sets process.exitCode=1 for JSON mode', async () => {
    const context = {
      args: { command: 'configure', json: true },
    } as unknown as CliContext;

    const handled = await handleConfigureCommand(context);

    expect(handled).toBe(true);
    expect(exitCodeSnapshot()).toBe(1);
  });

  it('returns handled=true AND sets process.exitCode=1 in human mode', async () => {
    const context = {
      args: { command: 'configure', json: false },
    } as unknown as CliContext;

    const handled = await handleConfigureCommand(context);

    expect(handled).toBe(true);
    expect(exitCodeSnapshot()).toBe(1);
  });
});
