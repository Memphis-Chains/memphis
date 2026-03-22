/**
 * Test gate for evolution sessions.
 *
 * Runs build:rust (if crates changed) → typecheck → lint → test:ts → test:rust.
 * Returns pass/fail with captured output.
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

interface GateStepDef {
  name: string;
  command: string;
  args: string[];
}

const RUST_BUILD_STEP: GateStepDef = {
  name: 'build:rust',
  command: 'npm',
  args: ['run', 'build:rust'],
};

const CORE_STEPS: GateStepDef[] = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'lint', command: 'npm', args: ['run', 'lint'] },
  { name: 'test:ts', command: 'npm', args: ['run', 'test:ts'] },
  { name: 'test:rust', command: 'npm', args: ['run', 'test:rust'] },
];

function needsRustBuild(changedFiles: string[]): boolean {
  return changedFiles.some((f) => f.startsWith('crates/') || f.startsWith('crates\\'));
}

function runStep(step: GateStepDef, cwd?: string): Promise<TestGateStep> {
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

export async function runTestGate(
  cwd?: string,
  changedFiles: string[] = [],
): Promise<TestGateResult> {
  const start = Date.now();
  const steps: TestGateStep[] = [];

  // Build Rust NAPI if any crates/ files changed
  const gateSteps = needsRustBuild(changedFiles)
    ? [RUST_BUILD_STEP, ...CORE_STEPS]
    : [...CORE_STEPS];

  for (const step of gateSteps) {
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
