/**
 * The shared failure classifier — one answer to "did this tool result fail?".
 *
 * These are hermetic: every fixture is a shape that was MEASURED on the
 * live corpus, not a shape somebody imagined. The rule exists because the
 * runtime and the corpus had two opinions about the same fact, and the
 * corpus was right about most of the results the runtime called success.
 *
 * The distinction that matters:
 *
 *   - a non-zero exit code is NOT automatically a failure (`grep` returns 1
 *     when it finds nothing), and
 *   - a non-zero exit code with a diagnostic IS a failure even when the
 *     diagnostic is on stdout rather than stderr.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyToolResult,
  toolOutputShape,
  type FailureClassification,
} from '../../src/core/failure-classification.js';
import { classifyToolOutput } from '../../src/infra/observability/instrument.js';

function classify(output: string): FailureClassification {
  return classifyToolResult(output).classification;
}

describe('classifyToolResult — the envelope speaks', () => {
  it('reads an error field as a failure', () => {
    expect(classify('{"error":"permission denied"}')).toBe('failure');
  });

  it('reads ok:false, blocked:true and status:error as failures', () => {
    expect(classify('{"ok":false}')).toBe('failure');
    expect(classify('{"blocked":true}')).toBe('failure');
    expect(classify('{"status":"error"}')).toBe('failure');
  });

  it('ignores an empty error field', () => {
    // Measured: every `error` field in the corpus is a non-empty string.
    // An empty one says nothing, and "says nothing" is not a failure.
    expect(classify('{"error":""}')).toBe('success');
  });

  it('does not call a result that merely mentions an error a failure', () => {
    // The measured trap: a naive substring scan flags 1 219 results that
    // are fine. The word "error" is usually in the COMMAND, not the outcome.
    expect(classify('{"stdout":"grep -i error access.log"}')).toBe('success');
    expect(classify('{"message":"chain \'journal\' not found"}')).toBe('success');
  });
});

describe('classifyToolResult — the process speaks', () => {
  it('calls a non-zero exit with a diagnostic a failure', () => {
    // Measured shapes: a node crash, a shell syntax error, a Python
    // traceback. 134 such results never reached the agent before.
    const nodeCrash = classifyToolResult(
      JSON.stringify({
        exitCode: 1,
        stderr:
          'node:fs:1590\n  const result = binding.readdir(\n\nError: ENOTDIR: not a directory',
        stdout: '',
      }),
    );
    expect(nodeCrash.classification).toBe('failure');
    expect(nodeCrash.reason).toContain('node:fs:1590');
    expect(nodeCrash.exitCode).toBe(1);

    expect(
      classify(JSON.stringify({ exitCode: 2, stderr: 'sh: 1: Syntax error: "(" unexpected' })),
    ).toBe('failure');
  });

  it('calls a silent "nothing matched" exit inconclusive', () => {
    // `grep` with no hit, `diff` with no difference, `test -f` on a missing
    // file. Not a success, not a failure — the state the old two-valued
    // rule had nowhere to put.
    expect(classify('{"exitCode":1,"stderr":"","stdout":""}')).toBe('inconclusive');
    expect(classify('{"exitCode":2,"stderr":"","stdout":"ls: cannot access"}')).toBe(
      'inconclusive',
    );
  });

  it('calls a command that was not found a failure even with empty stderr', () => {
    // Measured: six `exit 127` in the corpus, and the shell's
    // "sqlite3: not found" landed in stdout, not stderr.
    const verdict = classifyToolResult(
      '{"exitCode":127,"stderr":"","stdout":"sh: 1: sqlite3: not found"}',
    );
    expect(verdict.classification).toBe('failure');
    expect(verdict.reason).toBe('exit 127 (command not found)');
  });

  it('calls a timeout a failure even with empty stderr', () => {
    const verdict = classifyToolResult('{"exitCode":124,"stderr":""}');
    expect(verdict.classification).toBe('failure');
    expect(verdict.reason).toBe('exit 124 (timeout)');
  });

  it('calls a process killed by a signal a failure', () => {
    // 128+N, where N is the signal number. The shell's own usage error is
    // 128 and `ssh`'s error code is 255 — neither is a signal.
    const verdict = classifyToolResult('{"exitCode":137,"stderr":""}');
    expect(verdict.classification).toBe('failure');
    expect(verdict.reason).toBe('exit 137 (killed by signal 9)');
  });

  it("does not treat the shell usage error (128) or ssh's 255 as a signal", () => {
    // Measured: one `exit 255` in the corpus is a real ssh timeout, and the
    // code alone cannot tell it apart from a generic non-zero exit. It is
    // inconclusive, and the module says so rather than guessing.
    expect(classify('{"exitCode":128,"stderr":""}')).toBe('inconclusive');
    expect(classify('{"exitCode":255,"stderr":""}')).toBe('inconclusive');
  });

  it('calls a zero exit with a warning on stderr a success', () => {
    expect(classify('{"exitCode":0,"stderr":"warning: deprecated flag"}')).toBe('success');
  });
});

describe('classifyToolResult — what cannot be established', () => {
  it('treats an unparseable result as unknown, never as success', () => {
    expect(classify('not json')).toBe('unknown');
    expect(classify('')).toBe('unknown');
    expect(classify('[]')).toBe('unknown');
    expect(classify('null')).toBe('unknown');
    expect(classify('"a string"')).toBe('unknown');
  });

  it('keeps the parsed envelope when it parsed', () => {
    const verdict = classifyToolResult('{"exitCode":0,"ok":true}');
    expect(verdict.payload).toEqual({ exitCode: 0, ok: true });
    expect(verdict.exitCode).toBe(0);
  });
});

describe('one answer, two consumers', () => {
  it('gives the runtime and the corpus the same verdict', () => {
    // The corpus classifier and the runtime classifier used to disagree on
    // 267 of 8 437 results. They now read the same module, so they cannot.
    const cases = [
      '{"error":"boom"}',
      '{"ok":false}',
      '{"exitCode":1,"stderr":"Error: ENOTDIR"}',
      '{"exitCode":1,"stderr":""}',
      '{"exitCode":127,"stderr":""}',
      '{"exitCode":0}',
      'not json',
    ];
    for (const output of cases) {
      const shared = classifyToolResult(output);
      const runtime = classifyToolOutput(output);
      expect(runtime).toBe(toolOutputShape(shared));
      // The runtime's vocabulary keeps 'error' for a failure, so every
      // caller that tests `=== 'error'` keeps its meaning.
      if (shared.classification === 'failure') expect(runtime).toBe('error');
      if (shared.classification === 'inconclusive') expect(runtime).toBe('inconclusive');
    }
  });

  it('keeps the runtime vocabulary: failure is still called error', () => {
    expect(classifyToolOutput('{"error":"boom"}')).toBe('error');
    expect(classifyToolOutput('{"exitCode":127,"stderr":""}')).toBe('error');
    expect(classifyToolOutput('{"exitCode":1,"stderr":""}')).toBe('inconclusive');
    expect(classifyToolOutput('{"exitCode":0}')).toBe('success');
    expect(classifyToolOutput('not json')).toBe('unknown');
  });
});
