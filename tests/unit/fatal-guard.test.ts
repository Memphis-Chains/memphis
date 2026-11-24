/**
 * The fatal guard — the one place that decides what an error does to the
 * process.
 *
 * ## Why this gate exists
 *
 * The module had 211 lines and no test. It is the module that decides
 * whether a failed background task kills the operator's daemon, and the
 * rule it used to decide that was a token scan of the whole argv:
 *
 * ```ts
 * return argv.includes('serve');
 * ```
 *
 * Measured on the operator's host (2026-11-23), that answer was wrong
 * for every shape where the word appears anywhere but in the command
 * position:
 *
 * | invocation                            | token scan | the truth |
 * | ------------------------------------- | ---------- | --------- |
 * | `memphis serve`                       | daemon     | daemon    |
 * | `memphis mcp serve`                   | daemon     | daemon    |
 * | `memphis ask serve`                   | **daemon** | one-shot  |
 * | `memphis chain verify --chain serve`  | **daemon** | one-shot  |
 *
 * The consequence was measured end to end, not argued: with
 * `memphis ask serve` the process did NOT end on an unhandled
 * rejection — it logged it and kept running. That is the exact hang
 * this module's own header warns about: "the operator's shell would
 * hang".
 *
 * ## What the gate pins
 *
 * - the daemon decision comes from the CLI's own command, so the guard
 *   and the router cannot disagree about what is running;
 * - a daemon survives a rejected background task and dies on an
 *   undefined state (an uncaught exception);
 * - a one-shot CLI does the opposite;
 * - installing twice registers one pair of handlers, and so does
 *   installing after a reset — the reset has to take the old handlers
 *   off the process, not just clear a flag.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCommand } from '../../src/infra/cli/parser.js';
import { getCliCommandRegistrations } from '../../src/infra/cli/registry.js';
import {
  CLI_FATAL_POLICY,
  DAEMON_FATAL_POLICY,
  __resetFatalGuardForTests,
  getFatalPolicy,
  installFatalGuard,
  isDaemonInvocation,
  setFatalPolicy,
} from '../../src/infra/runtime/fatal-guard.js';

type ProcessListener = (...args: unknown[]) => void;

function listeners(event: 'uncaughtException' | 'unhandledRejection'): ProcessListener[] {
  return process.listeners(event) as ProcessListener[];
}

afterEach(() => {
  // Take the guard off the worker, so the next file starts clean.
  __resetFatalGuardForTests();
  vi.restoreAllMocks();
});

describe('the fatal guard — telling the daemon from the one-shot CLI', () => {
  it('calls the daemon only for the daemon', () => {
    const shapes: Array<{ argv: string[]; daemon: boolean }> = [
      { argv: ['node', 'cli', 'serve'], daemon: true },
      { argv: ['node', 'cli', 'serve', '--port', '8080'], daemon: true },
      { argv: ['node', 'cli', 'mcp', 'serve'], daemon: true },
      { argv: ['node', 'cli', 'mcp', 'serve', '--transport', 'http'], daemon: true },
      { argv: ['node', 'cli', 'ask', 'serve'], daemon: false },
      { argv: ['node', 'cli', 'chain', 'verify', '--chain', 'serve'], daemon: false },
      { argv: ['node', 'cli', 'export', '--into', 'serve'], daemon: false },
      { argv: ['node', 'cli', 'ask'], daemon: false },
      { argv: ['node', 'cli', 'mcp', 'serve-once'], daemon: false },
      { argv: ['node', 'cli', 'tui'], daemon: false },
    ];

    const wrong = shapes
      .filter((shape) => isDaemonInvocation(shape.argv) !== shape.daemon)
      .map((shape) => `${shape.argv.slice(2).join(' ')} -> ${isDaemonInvocation(shape.argv)}`);
    expect(wrong).toEqual([]);
  });

  it('the daemon is exactly the two long-running commands, and both are routable', () => {
    // The set is written out here on purpose: the guard does not know
    // about it. The rule under test is "the long-running commands and
    // nothing else".
    const LONG_RUNNING = new Set(['serve', 'mcp serve']);
    const shapes = [
      ['node', 'cli', 'serve'],
      ['node', 'cli', 'serve', '--port', '8080'],
      ['node', 'cli', 'mcp', 'serve'],
      ['node', 'cli', 'mcp', 'serve', '--transport', 'http'],
      ['node', 'cli', 'mcp', 'serve-once'],
      ['node', 'cli', 'ask', 'serve'],
      ['node', 'cli', 'chain', 'verify', '--chain', 'serve'],
      ['node', 'cli', 'export', '--into', 'serve'],
      ['node', 'cli', '--safe-mode', 'serve'],
      ['node', 'cli', 'ask'],
      ['node', 'cli', 'tui'],
    ];

    for (const argv of shapes) {
      const { command, subcommand } = parseCommand(argv);
      const key = command === 'mcp' ? `${command} ${subcommand}` : String(command);

      expect(isDaemonInvocation(argv), argv.slice(2).join(' ')).toBe(LONG_RUNNING.has(key));

      // And the command the guard read is a command the router knows.
      expect(getCliCommandRegistrations(command).length, key).toBeGreaterThan(0);
    }
  });

  it('installs the daemon policy for the daemon', () => {
    const policy = installFatalGuard(['node', 'cli', 'serve']);

    expect(policy.exitOnUnhandledRejection).toBe(false);
    expect(policy.exitOnUncaughtException).toBe(true);
  });

  it('a daemon survives a rejected background task', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installFatalGuard(['node', 'cli', 'serve']);

    const handler = listeners('unhandledRejection').at(-1);
    expect(handler).toBeDefined();
    handler?.(new Error('background task failed'), Promise.resolve());

    expect(exit).not.toHaveBeenCalled();
  });

  it('a daemon dies on an undefined state', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installFatalGuard(['node', 'cli', 'serve']);

    const handler = listeners('uncaughtException').at(-1);
    expect(handler).toBeDefined();
    handler?.(new Error('state is undefined'));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a one-shot CLI ends the process on a rejected task', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installFatalGuard(['node', 'cli', 'ask']);
    setFatalPolicy(CLI_FATAL_POLICY);

    const handler = listeners('unhandledRejection').at(-1);
    expect(handler).toBeDefined();
    handler?.(new Error('background task failed'), Promise.resolve());

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('installing twice registers one pair of handlers', () => {
    const before = listeners('unhandledRejection').length;

    installFatalGuard(['node', 'cli', 'ask']);
    installFatalGuard(['node', 'cli', 'ask']);

    expect(listeners('unhandledRejection').length - before).toBe(1);
    expect(listeners('uncaughtException').length).toBeGreaterThan(0);
  });

  it('a reset takes the handlers back off the process', () => {
    const before = listeners('unhandledRejection').length;

    installFatalGuard(['node', 'cli', 'ask']);
    expect(listeners('unhandledRejection').length - before).toBe(1);

    __resetFatalGuardForTests();
    expect(listeners('unhandledRejection').length).toBe(before);

    // And a reinstall after the reset adds exactly one pair — not two.
    installFatalGuard(['node', 'cli', 'ask']);
    expect(listeners('unhandledRejection').length - before).toBe(1);
  });

  it('the policy in force is readable and replaceable', () => {
    setFatalPolicy(DAEMON_FATAL_POLICY);
    expect(getFatalPolicy()).toEqual(DAEMON_FATAL_POLICY);

    setFatalPolicy(CLI_FATAL_POLICY);
    expect(getFatalPolicy()).toEqual(CLI_FATAL_POLICY);
  });
});
