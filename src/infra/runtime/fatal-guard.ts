/**
 * The fatal guard — the one place that decides what an error does to the
 * process.
 *
 * ## Why this module exists
 *
 * The runtime serves an operator's LLMs. It is a long-lived daemon, and a
 * daemon that dies because one background task gave up is a daemon that
 * stops serving the operator mid-conversation. The previous arrangement —
 * `process.on('unhandledRejection', () => process.exit(1))` registered in
 * the CLI entry point — made that the *default* outcome of a class of
 * ordinary bugs:
 *
 * ```text
 * scheduler.ts:  this.timer = setInterval(() => void this.tick(), this.intervalMs);
 * //              ^ `void` discards the rejection, and tick() had a `finally`
 * //                but no `catch`. One malformed task file => the daemon
 * //                exited(1) every 30 seconds.
 * ```
 *
 * The measurement that motivated this file: on the operator's host, the
 * daemon restarted on a fixed cadence because a scheduler tick could
 * reject, and the rejection reached a handler that called `process.exit`.
 *
 * ## The contract
 *
 * One rule, two cases, no exceptions:
 *
 * - **`unhandledRejection`** — exactly one task failed and nobody was
 *   waiting on it. The process is still healthy. Log it, count it, keep
 *   serving. In daemon mode this MUST NOT exit the process.
 * - **`uncaughtException`** — the process state is undefined. Log it and
 *   exit non-zero so the supervisor restarts a *clean* process. This is
 *   the one case where dying is the correct answer, because the
 *   alternative is a daemon whose invariants are unknown.
 *
 * ## Why it is installed first
 *
 * ES module imports are hoisted and evaluated before any statement in the
 * importing module. The old handlers sat at the bottom of the CLI entry
 * point, which meant the entire import graph — the Rust bridge, the
 * gateway, the MCP server, the chain adapter — was evaluated *before* the
 * handlers existed. A `throw` during module evaluation therefore killed
 * the daemon through Node's default handler: no pino line, no drain, no
 * context. `src/infra/cli/index.ts` now imports this module first, so the
 * guard is live before the rest of the graph is evaluated.
 *
 * ## Policy
 *
 * The CLI and the daemon want different things from an unhandled
 * rejection:
 *
 * - The **CLI** should exit. A fire-and-forget promise that rejects
 *   leaves nothing to await, and the operator's shell would hang.
 * - The **daemon** must not exit. It has other work to do.
 *
 * The mode is read from the invocation (`serve` in argv) so the decision
 * is made before the graph is evaluated, and `setFatalPolicy` lets the
 * bootstrap state the mode explicitly as well — so the behaviour does not
 * depend on the spelling of a command name.
 */

import { LOG_LEVEL, NODE_ENV } from '../../config/env-registry.js';
import { parseCommand } from '../cli/parser.js';
import { createPinoLogger } from '../logging/pino.js';

/**
 * What an error is allowed to do to the process.
 *
 * `exitOnUncaughtException` is deliberately not configurable at runtime in
 * a way that could be flipped from the environment: an undefined-state
 * process must be replaced, and that is not an operator preference.
 */
export interface FatalPolicy {
  /** Exit the process when a rejection has no handler. */
  exitOnUnhandledRejection: boolean;
  /** Exit the process when an exception escapes the event loop. */
  exitOnUncaughtException: boolean;
}

/**
 * CLI policy: exit on both. A one-shot command that loses track of a
 * rejection has nothing left to do, and the shell must get its prompt
 * back.
 */
export const CLI_FATAL_POLICY: FatalPolicy = {
  exitOnUnhandledRejection: true,
  exitOnUncaughtException: true,
};

/**
 * Daemon policy: a rejected background task is a bug in that task, not in
 * the process. The daemon keeps serving the operator's other work.
 */
export const DAEMON_FATAL_POLICY: FatalPolicy = {
  exitOnUnhandledRejection: false,
  exitOnUncaughtException: true,
};

const fatalLog = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

let policy: FatalPolicy = CLI_FATAL_POLICY;
let installed = false;

/**
 * The handlers this module registered, so they can be taken back off.
 *
 * Without them the reset below could only clear the flag, and a
 * reinstall would add a SECOND pair of handlers — the double-logging
 * this module's own docstring calls out. The reset is what a test
 * needs, so it has to leave the process exactly as it found it.
 */
let installedHandlers:
  | { onUncaughtException: (error: Error) => void; onUnhandledRejection: (reason: unknown) => void }
  | undefined;

/**
 * True when this process is the `serve` daemon.
 *
 * Read from argv because the decision has to be made before the import
 * graph is evaluated — that is the whole point of installing the guard
 * first. `setFatalPolicy` from the bootstrap is the second, authoritative
 * signal; this is the fast path that closes the import-time window.
 *
 * ## Why the command, and not the word "serve"
 *
 * This used to be `argv.includes('serve')` — a token scan of the whole
 * argv. That answer was wrong for every shape where the word appears
 * anywhere but in the command position:
 *
 * | invocation                       | token scan | the truth |
 * | -------------------------------- | ---------- | --------- |
 * | `memphis serve`                  | daemon     | daemon    |
 * | `memphis mcp serve`              | daemon     | daemon    |
 * | `memphis ask serve`              | **daemon** | one-shot  |
 * | `memphis chain verify --chain serve` | **daemon** | one-shot |
 *
 * Measured on the operator's host (2026-11-23), `memphis ask serve` did
 * NOT end the process on an unhandled rejection — the guard was in
 * daemon mode, so the rejection was logged and the one-shot CLI kept
 * running. That is the exact hang this module's own header warns about:
 * "the operator's shell would hang".
 *
 * The rule now asks the CLI what the command is. `parseCommand` is the
 * owner of that question — the dispatcher routes on the same value, so
 * the guard and the router cannot disagree about what is being run.
 *
 * `mcp serve` is a server too, and it is the second long-running process
 * this guard has to keep alive.
 */
export function isDaemonInvocation(argv: readonly string[] = process.argv ?? []): boolean {
  const { command, subcommand } = parseCommand([...argv]);
  if (command === 'serve') return true;
  return command === 'mcp' && subcommand === 'serve';
}

/** The policy currently in force. */
export function getFatalPolicy(): FatalPolicy {
  return { ...policy };
}

/**
 * Replace the policy. Used by the bootstrap to state the mode explicitly
 * rather than relying on the argv spelling.
 */
export function setFatalPolicy(next: FatalPolicy): void {
  policy = {
    exitOnUnhandledRejection: next.exitOnUnhandledRejection,
    exitOnUncaughtException: next.exitOnUncaughtException,
  };
}

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  return { message: String(value) };
}

/**
 * Install the guard. Idempotent — calling it twice does not register two
 * handlers, which would double-log every error.
 *
 * @returns the policy that was installed.
 */
export function installFatalGuard(argv: readonly string[] = process.argv ?? []): FatalPolicy {
  if (installed) return getFatalPolicy();
  installed = true;

  if (isDaemonInvocation(argv)) {
    setFatalPolicy(DAEMON_FATAL_POLICY);
  }

  const onUncaughtException = (error: Error) => {
    const detail = describe(error);
    fatalLog.error(
      { err: error, event: 'fatal.uncaught_exception' },
      `uncaught exception: ${detail.message}`,
    );
    if (LOG_LEVEL.read(process.env) === 'debug' && detail.stack) {
      fatalLog.debug({ stack: detail.stack }, 'uncaught exception stack');
    }
    if (policy.exitOnUncaughtException) {
      // The process state is undefined. Exit non-zero so the supervisor
      // starts a clean one instead of continuing on unknown invariants.
      process.exit(1);
    }
  };

  const onUnhandledRejection = (reason: unknown) => {
    const detail = describe(reason);
    fatalLog.error(
      { err: reason, event: 'fatal.unhandled_rejection' },
      `unhandled rejection: ${detail.message}`,
    );
    if (LOG_LEVEL.read(process.env) === 'debug' && detail.stack) {
      fatalLog.debug({ stack: detail.stack }, 'unhandled rejection stack');
    }
    if (policy.exitOnUnhandledRejection) {
      process.exit(1);
    }
    // Daemon mode: the rejection is recorded and the runtime keeps
    // serving. The failing task is responsible for its own recovery; the
    // process is not the casualty of one task's failure.
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  installedHandlers = { onUncaughtException, onUnhandledRejection };

  return getFatalPolicy();
}

/**
 * Test-only: take the guard off the process and clear the installed
 * flag so it can be reinstalled.
 *
 * Both halves matter. Clearing only the flag would leave the old
 * handlers on the process, and the next `installFatalGuard()` would add
 * a second pair — every error logged twice, and every `process.exit`
 * reached twice. The module promises that installing twice does not
 * register two handlers; this is the only way that promise survives a
 * reset.
 */
export function __resetFatalGuardForTests(): void {
  if (installedHandlers) {
    process.off('uncaughtException', installedHandlers.onUncaughtException);
    process.off('unhandledRejection', installedHandlers.onUnhandledRejection);
  }
  installedHandlers = undefined;
  installed = false;
}

// Install on import.
//
// This is a side effect on purpose. ES module imports are evaluated
// before the importing module's body, so a call to `installFatalGuard()`
// placed in the CLI entry point's body would run *after* the whole
// import graph — the Rust bridge, the gateway, the MCP server — had
// already been evaluated. A `throw` during that evaluation is exactly
// the case the guard exists to catch, so the installation has to happen
// as part of evaluating the guard module itself.
//
// The CLI entry point therefore imports this module FIRST. `src/infra/cli/index.ts`
// carries a comment saying so; keep the two in step.
//
// Tests opt out: a test runner has its own rejection handling, and this
// guard's CLI policy would exit the worker on the first stray rejection.
if (NODE_ENV.read(process.env) !== 'test') {
  installFatalGuard();
}
