/**
 * The agent's "do NOT claim success" summary.
 *
 * This is the falsifier R1 was written against: the summary must reach the
 * model the failures it caused. Before the shared classifier existed, the
 * summary was built from the envelope only, and every failure that arrived
 * as a non-zero exit code was invisible to the agent.
 *
 * Measured on the live corpus (2026-11-03): 134 real failures — a node
 * crash, a shell syntax error, a Python traceback — never reached the
 * model that had just caused them.
 */

import { describe, expect, it } from 'vitest';

import { buildToolErrorSummary } from '../../src/gateway/agent-runtime.js';
import type { ToolExecutionResult } from '../../src/gateway/tool-orchestration.js';

function result(name: string, output: string): ToolExecutionResult {
  return { call: { id: 'c1', name, arguments: {} } as ToolExecutionResult['call'], output };
}

describe('buildToolErrorSummary', () => {
  it('says nothing when nothing failed', () => {
    expect(buildToolErrorSummary([])).toBeUndefined();
    expect(buildToolErrorSummary([result('memphis_exec', '{"exitCode":0}')])).toBeUndefined();
  });

  it('reports a failure the envelope carries', () => {
    const summary = buildToolErrorSummary([result('memphis_git', '{"error":"permission denied"}')]);
    expect(summary).toContain('memphis_git');
    expect(summary).toContain('permission denied');
  });

  it('reports a failure the process explained on stderr', () => {
    // The case the runtime used to be blind to.
    const summary = buildToolErrorSummary([
      result(
        'memphis_exec',
        JSON.stringify({ exitCode: 1, stderr: 'Error: ENOTDIR: not a directory' }),
      ),
    ]);
    expect(summary).toContain('memphis_exec');
    expect(summary).toContain('ENOTDIR');
  });

  it('names the exit code when stderr is empty', () => {
    // `command not found` and `timeout` are failures whose diagnostic
    // never reached stderr. Without the code they are invisible.
    const summary = buildToolErrorSummary([
      result('memphis_exec', '{"exitCode":127,"stderr":"","stdout":"sh: 1: sqlite3: not found"}'),
      result('memphis_exec', '{"exitCode":124,"stderr":""}'),
    ]);
    expect(summary).toContain('exit 127 (command not found)');
    expect(summary).toContain('exit 124 (timeout)');
  });

  it('does not report a silent non-zero exit that explained nothing', () => {
    // `grep` with no hit. Not a failure, so the agent is not told it is one.
    expect(
      buildToolErrorSummary([result('memphis_exec', '{"exitCode":1,"stderr":""}')]),
    ).toBeUndefined();
  });
});
