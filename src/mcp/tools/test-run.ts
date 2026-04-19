/**
 * memphis_test — run project tests via the existing test gate infrastructure.
 *
 * Tier 2: executes test commands.
 * Wraps the test-gate.ts infrastructure that runs typecheck, lint, and tests.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export type MemphisTestInput = {
  /** Which test suite to run: "all" | "ts" | "rust" | "lint" | "typecheck" */
  suite?: string;
  /** Optional filter pattern for test files/names (vitest --run <filter>) */
  filter?: string;
};

export type MemphisTestOutput = {
  passed: boolean;
  suite: string;
  output: string;
  durationMs: number;
  error?: string;
};

const PROJECT_ROOT = path.join(os.homedir(), 'memphis');

const SAFE_FILTER_RE = /^[A-Za-z0-9_.,/ -]+$/;

const SUITES: Record<string, { command: string; args: string[] }> = {
  ts: { command: 'npx', args: ['vitest', 'run'] },
  rust: { command: 'npm', args: ['run', 'test:rust'] },
  lint: { command: 'npm', args: ['run', 'lint'] },
  typecheck: { command: 'npm', args: ['run', 'typecheck'] },
};

export function runMemphisTest(input: MemphisTestInput): MemphisTestOutput {
  const suite = input.suite ?? 'ts';
  const start = Date.now();

  if (suite === 'all') {
    // Run the full test gate
    const results: MemphisTestOutput[] = [];
    for (const s of ['typecheck', 'lint', 'ts', 'rust']) {
      results.push(runMemphisTest({ suite: s }));
      if (!results[results.length - 1].passed) {
        const failed = results[results.length - 1];
        return {
          passed: false,
          suite: 'all',
          output:
            results.map((r) => `[${r.suite}] ${r.passed ? 'PASS' : 'FAIL'}`).join('\n') +
            '\n\n' +
            failed.output,
          durationMs: Date.now() - start,
        };
      }
    }
    return {
      passed: true,
      suite: 'all',
      output: results.map((r) => `[${r.suite}] PASS (${r.durationMs}ms)`).join('\n'),
      durationMs: Date.now() - start,
    };
  }

  const config = SUITES[suite];
  if (!config) {
    return {
      passed: false,
      suite,
      output: '',
      durationMs: 0,
      error: `Unknown suite '${suite}'. Available: ${Object.keys(SUITES).join(', ')}, all`,
    };
  }

  const args = [...config.args];
  if (suite === 'ts' && input.filter) {
    // Restrict filter to a test-name pattern. Anything starting with '-'
    // would become a vitest CLI flag, and --config=<path> loads arbitrary
    // JS — chained with fs-write that's a tier-2 → arbitrary-code-exec
    // elevation (#137).
    if (!SAFE_FILTER_RE.test(input.filter) || input.filter.startsWith('-')) {
      return {
        passed: false,
        suite,
        output: '',
        durationMs: 0,
        error: `filter must be a plain test-name pattern (letters, digits, _.,/ -); flags are not allowed`,
      };
    }
    args.push(input.filter);
  }

  try {
    const output = execFileSync(config.command, args, {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      timeout: 5 * 60 * 1000,
      maxBuffer: 5 * 1024 * 1024,
    });

    return {
      passed: true,
      suite,
      output: output.slice(-3000),
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const stdout = (err as { stdout?: string }).stdout ?? '';
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const output = (stdout + '\n' + stderr).trim().slice(-3000);

    return {
      passed: false,
      suite,
      output,
      durationMs: Date.now() - start,
    };
  }
}
