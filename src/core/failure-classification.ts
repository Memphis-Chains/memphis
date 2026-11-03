/**
 * One answer to the question "did this tool result fail?".
 *
 * WHY THIS MODULE EXISTS
 * -----------------------
 * The runtime had two opinions about the same fact, and the weaker one was
 * wired into the telemetry. `classifyToolOutput`
 * (`src/infra/observability/instrument.ts`) read the envelope only; the
 * dreaming corpus classifier read the envelope AND the process exit code.
 * Measured over the live corpus (8 437 tool results, 2026-11-03) they
 * disagreed on **267** results — and the corpus was right about most of
 * them: a node crash, a shell syntax error and a Python traceback all
 * arrived with a non-zero exit code and were invisible to the runtime.
 *
 * Neither copy is kept here. This module is the single copy, and the
 * runtime, the gateway and the corpus all read it.
 *
 * THE RULE, AND WHY IT IS FOUR STATES
 * -----------------------------------
 * A process that exits non-zero has NOT necessarily failed. `grep` returns
 * 1 when it finds nothing; `diff` returns 1 when the files are identical;
 * `ls` returns 2 for a path that does not exist. Those are not agent
 * errors, and a classifier that counts them as such measures the wrong
 * thing — the naive rule scores 5.14 % on this corpus and would flip the
 * tool-error SLO on the strength of results that are fine.
 *
 * So the answer is four-valued, and the two that matter are separated:
 *
 *   failure       the envelope says so, or the process failed AND said
 *                 why, or it exited with a code that cannot mean "nothing
 *                 matched"
 *   inconclusive  the process exited non-zero and said nothing about why.
 *                 The shell said no and gave no reason. This is NOT a
 *                 success and NOT a failure, and pretending otherwise is
 *                 what made the old two-valued rule wrong in both
 *                 directions.
 *   success       exited zero, or the envelope says it worked
 *   unknown       the envelope did not parse. Never counted as success.
 *
 * MEASURED ON THE LIVE CORPUS (2026-11-03, 8 437 results)
 * -------------------------------------------------------
 *   failure       308 (3.65 %)
 *   inconclusive  126
 *   success      8 003
 *   unknown        0
 *
 * Of the 126 inconclusive results, 106 are `exit 1` and 16 are `exit 2` —
 * the "nothing matched" family. The six `exit 127` (command not found) and
 * the one `exit 124` (timeout) are counted as failures even though their
 * stderr is empty, because a code that cannot mean "nothing matched" is a
 * failure on its own.
 *
 * ONE KNOWN LIMIT, STATED PLAINLY
 * --------------------------------
 * One `exit 255` in this corpus is a real failure (an `ssh` timeout) whose
 * diagnostic sits in stdout, and it is classified `inconclusive`: 255 is
 * `ssh`'s own error code, not a signal death, so the code alone cannot
 * tell it apart from a generic non-zero exit. The state exists precisely
 * to say "the shell said no and did not say why" instead of guessing.
 */

/** The four answers this module gives. */
export type FailureClassification = 'success' | 'failure' | 'inconclusive' | 'unknown';

/** A classified tool result, with the evidence that produced the answer. */
export interface FailureVerdict {
  /** The answer itself. */
  classification: FailureClassification;
  /** The process exit code, when the envelope carries one. */
  exitCode?: number;
  /** The failure reason the envelope carries, when it carries one. */
  error?: string;
  /**
   * A one-line, human-readable reason: the envelope's error, else the
   * process's own diagnostic, else the exit code and what it means. This
   * is what the agent is told, so it has to name the exit code — a
   * `command not found` with an empty stderr is otherwise invisible.
   */
  reason?: string;
  /** The parsed envelope, when it parsed. */
  payload?: Record<string, unknown>;
}

/**
 * Exit codes that cannot mean "nothing matched".
 *
 * 124 is `timeout`'s, 126 is "not executable", 127 is "command not found".
 * A process that dies of a signal is reported by the shell as 128+N, where
 * N is the signal number — so the signal range is 129..192. 128 itself is
 * the shell's usage error and 255 is `ssh`'s own, and neither is a signal.
 */
const HARD_EXIT_CODES: ReadonlyMap<number, string> = new Map([
  [124, 'timeout'],
  [126, 'not executable'],
  [127, 'command not found'],
]);

function isSignalDeath(code: number): boolean {
  return code >= 129 && code <= 192;
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function describeExitCode(code: number): string {
  const hard = HARD_EXIT_CODES.get(code);
  if (hard !== undefined) return `exit ${code} (${hard})`;
  if (isSignalDeath(code)) return `exit ${code} (killed by signal ${code - 128})`;
  return `exit ${code}`;
}

/**
 * Classify a tool result.
 *
 * The input is the stringified tool output, exactly as the runtime has it.
 * Everything the answer is based on is in that string: the envelope's own
 * fields, the process exit code, and what the process wrote to stderr.
 */
export function classifyToolResult(output: string): FailureVerdict {
  const trimmed = (output ?? '').trim();
  if (trimmed.length === 0) {
    return { classification: 'unknown' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A missing or malformed structure is not evidence of success.
    return { classification: 'unknown' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { classification: 'unknown' };
  }

  const payload = parsed as Record<string, unknown>;
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : undefined;
  const stderr = typeof payload.stderr === 'string' ? payload.stderr : '';
  const rawError = payload.error;
  const error =
    typeof rawError === 'string' && rawError.trim().length > 0 ? rawError.trim() : undefined;

  const envelopeSaysFailure =
    error !== undefined ||
    payload.ok === false ||
    payload.blocked === true ||
    payload.status === 'error';

  const exitFailed = exitCode !== undefined && exitCode !== 0;
  const stderrExplains = stderr.trim().length > 0;
  const codeCannotMeanNoMatch =
    exitCode !== undefined && (HARD_EXIT_CODES.has(exitCode) || isSignalDeath(exitCode));

  const reason =
    error ?? firstNonEmptyLine(stderr) ?? (exitFailed ? describeExitCode(exitCode!) : undefined);

  if (envelopeSaysFailure) {
    return { classification: 'failure', exitCode, error, reason, payload };
  }
  if (exitFailed && (stderrExplains || codeCannotMeanNoMatch)) {
    return { classification: 'failure', exitCode, error, reason, payload };
  }
  if (exitFailed) {
    // The shell said no and gave no reason. Not a success, not a failure.
    return { classification: 'inconclusive', exitCode, error, reason, payload };
  }
  return { classification: 'success', exitCode, error, reason, payload };
}

/**
 * The vocabulary the telemetry already speaks.
 *
 * `failure` keeps the old name `error`, so every caller that tests
 * `=== 'error'` keeps its meaning; `inconclusive` is new and is the whole
 * point of the change — the telemetry can now say "the shell said no and
 * gave no reason" instead of calling it a success.
 */
export type ToolOutputShape = 'success' | 'error' | 'inconclusive' | 'unknown';

export function toolOutputShape(verdict: FailureVerdict): ToolOutputShape {
  if (verdict.classification === 'failure') return 'error';
  return verdict.classification;
}
