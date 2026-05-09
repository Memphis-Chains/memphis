/**
 * Closure sprint Z.4.1 (2026-05-09): smoke coverage for the schedule
 * command handler. Pre-Z.4.1 the handler had no dedicated test —
 * it was exercised only via dispatcher smoke. These two cases pin
 * the dispatch contract: list returns JSON of registered tasks, and
 * unknown subcommands surface a usage hint without throwing.
 */
import { describe, expect, it, vi } from 'vitest';

const listTasksMock = vi.fn(() => [] as ReadonlyArray<unknown>);

vi.mock('../../src/infra/runtime/scheduler.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/infra/runtime/scheduler.js')>(
    '../../src/infra/runtime/scheduler.js',
  );
  return {
    ...actual,
    getScheduler: vi.fn(() => ({
      listTasks: listTasksMock,
      addTask: vi.fn(),
      removeTask: vi.fn(),
      enableTask: vi.fn(),
      disableTask: vi.fn(),
    })),
  };
});

const { scheduleCommandHandler } = await import(
  '../../src/infra/cli/handlers/schedule.handler.js'
);

import type { CliContext } from '../../src/infra/cli/context.js';

function buildContext(opts: { subcommand?: string; json?: boolean } = {}): CliContext {
  return {
    argv: [],
    args: {
      command: 'schedule',
      subcommand: opts.subcommand,
      json: opts.json ?? false,
    } as CliContext['args'],
    getConfig: () => ({}) as ReturnType<CliContext['getConfig']>,
    getContainer: () => ({}) as ReturnType<CliContext['getContainer']>,
  };
}

describe('schedule command handler', () => {
  it('list (or no subcommand) returns empty task array as JSON (happy path, no auth required)', async () => {
    listTasksMock.mockReturnValue([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await scheduleCommandHandler.handle(
        buildContext({ subcommand: 'list', json: true }),
      );
      expect(result).toBe(true);
      const printed = log.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(printed) as { tasks: unknown[] };
      expect(Array.isArray(parsed.tasks)).toBe(true);
      expect(parsed.tasks).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it('unknown subcommand surfaces usage hint to stderr (error path, no auth check on read)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await scheduleCommandHandler.handle(
        buildContext({ subcommand: 'gibberish' }),
      );
      expect(result).toBe(true);
      const calls = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((line) => line.includes('Unknown subcommand: gibberish'))).toBe(true);
      expect(calls.some((line) => line.includes('memphis schedule help'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
