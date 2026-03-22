/**
 * Test gate for evolution sessions.
 *
 * Runs typecheck, lint, and tests. Returns pass/fail with captured output.
 */

import { execFile } from 'node:child_process';

export interface TestGateResult {
  passed: boolean;
  steps: TestGateStep[];
  durationMs: number;
}

export interface TestGateStep {
  name: string;
  command: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

const GATE_STEPS: Array<{ name: string; command: string; args: string[] }> = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'lint', command: 'npm', args: ['run', 'lint'] },
  { name: 'test', command: 'npm', args: ['run', 'test:ts'] },
];

function runStep(
  step: { name: string; command: string; args: string[] },
  cwd?: string,
): Promise<TestGateStep> {
  const start = Date.now();
  return new Promise((resolve) => {
    execFile(
      step.command,
      step.args,
      { cwd, maxBuffer: 5 * 1024 * 1024, timeout: 5 * 60 * 1000 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const output = (stdout + '\n' + stderr).trim().slice(-2000);
        resolve({
          name: step.name,
          command: `${step.command} ${step.args.join(' ')}`,
          passed: !err,
          output,
          durationMs,
        });
      },
    );
  });
}

export async function runTestGate(cwd?: string): Promise<TestGateResult> {
  const start = Date.now();
  const steps: TestGateStep[] = [];

  for (const step of GATE_STEPS) {
    const result = await runStep(step, cwd);
    steps.push(result);

    // Fail fast — don't run remaining steps if one fails
    if (!result.passed) {
      return {
        passed: false,
        steps,
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    passed: true,
    steps,
    durationMs: Date.now() - start,
  };
}
