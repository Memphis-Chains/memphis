/**
 * Closure sprint Z.4.1 (2026-05-09): smoke coverage for the operator
 * command handler. Pre-Z.4.1 the handler had no dedicated test —
 * it was exercised only via `cli-router.integration.test.ts`'s
 * dispatcher smoke and indirectly through `operator-gate` unit tests.
 * These two cases pin the dispatch contract: status reports JSON when
 * --json + configured, and unknown subcommands surface a usage hint.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infra/auth/operator-gate.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/infra/auth/operator-gate.js')>(
    '../../src/infra/auth/operator-gate.js',
  );
  return {
    ...actual,
    loadOperatorConfig: vi.fn(() => ({
      schemaVersion: 1,
      passphraseHash: 'mock-hash',
      salt: 'mock-salt',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-05-09T00:00:00.000Z',
      recoveryQuestionHint: 'mock?',
      recoveryHash: 'mock-recovery',
    })),
    isOperatorConfigured: vi.fn(() => true),
  };
});

const { operatorCommandHandler } = await import(
  '../../src/infra/cli/handlers/operator.handler.js'
);

import type { CliContext } from '../../src/infra/cli/context.js';

function buildContext(opts: { subcommand?: string; json?: boolean } = {}): CliContext {
  return {
    argv: [],
    args: {
      command: 'operator',
      subcommand: opts.subcommand,
      json: opts.json ?? false,
    } as CliContext['args'],
    getConfig: () => ({}) as ReturnType<CliContext['getConfig']>,
    getContainer: () => ({}) as ReturnType<CliContext['getContainer']>,
  };
}

describe('operator command handler', () => {
  it('status subcommand reports configured operator with JSON payload (happy path)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await operatorCommandHandler.handle(
        buildContext({ subcommand: 'status', json: true }),
      );
      expect(result).toBe(true);
      expect(log).toHaveBeenCalledOnce();
      const printed = log.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(printed) as {
        configured: boolean;
        hasRecovery: boolean;
        createdAt: string;
        updatedAt: string;
      };
      expect(parsed.configured).toBe(true);
      expect(parsed.hasRecovery).toBe(true);
      expect(parsed.createdAt).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      log.mockRestore();
    }
  });

  it('unknown subcommand surfaces usage hint to stderr (error path)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await operatorCommandHandler.handle(
        buildContext({ subcommand: 'gibberish' }),
      );
      // Handler returns true to signal "command was claimed" so the
      // dispatcher doesn't fall through to the unknown-command path —
      // the error is surfaced to stderr instead.
      expect(result).toBe(true);
      const calls = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((line) => line.includes('Unknown operator subcommand: gibberish'))).toBe(
        true,
      );
      expect(
        calls.some((line) => line.includes('Usage: memphis operator <status|set-passphrase|recover>')),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
