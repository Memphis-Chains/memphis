import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runMemphisCodeRead } from '../../src/mcp/tools/code-read.js';

/**
 * The TypeScript arm of `memphis_code_read`, checked against the cases
 * where it and the native arm used to disagree.
 *
 * `tests/fixtures/code-read-contract.json` holds the cases; the native
 * runner is `crates/memphis-operator/tests/code_read_contract.rs`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'code-read-contract.json');

type ContractExpectation =
  | { ok: true; content?: string; lineCount?: number; totalLines?: number; truncated?: boolean }
  | { ok: false; error: string };

type ContractCase = {
  name: string;
  files?: { path: string; content: string }[];
  symlinks?: { path: string; target: string }[];
  call: { path: string; startLine?: number; endLine?: number; limit?: number };
  expect: ContractExpectation;
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: ContractCase[] };

function render(template: string, home: string): string {
  return template.replace('{ROOT}', path.join(home, 'memphis')).replace('{HOME}', home);
}

describe('memphis_code_read — the two arms agree', () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('every case in the shared table behaves the same way', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    const failures: string[] = [];

    for (const [index, testCase] of fixture.cases.entries()) {
      const home = mkdtempSync(path.join(os.tmpdir(), `memphis-code-read-contract-${index}-`));
      try {
        process.env.HOME = home;
        for (const file of testCase.files ?? []) {
          const target = render(file.path, home);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, file.content, 'utf8');
        }
        for (const link of testCase.symlinks ?? []) {
          const target = render(link.path, home);
          mkdirSync(path.dirname(target), { recursive: true });
          symlinkSync(render(link.target, home), target);
        }

        const call = testCase.call;
        let output: ReturnType<typeof runMemphisCodeRead> | undefined;
        let failure: string | undefined;
        try {
          output = runMemphisCodeRead({
            path: render(call.path, home),
            startLine: call.startLine,
            endLine: call.endLine,
            limit: call.limit,
          });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }

        const expect = testCase.expect;
        if (expect.ok) {
          if (!output) {
            failures.push(`${testCase.name}: expected a read, got ${failure ?? ''}`);
          } else {
            if (expect.content !== undefined && output.content !== expect.content) {
              failures.push(
                `${testCase.name}: content was ${JSON.stringify(output.content)}, expected ${JSON.stringify(expect.content)}`,
              );
            }
            if (expect.lineCount !== undefined && output.lineCount !== expect.lineCount) {
              failures.push(
                `${testCase.name}: lineCount was ${output.lineCount}, expected ${expect.lineCount}`,
              );
            }
            if (expect.totalLines !== undefined && output.totalLines !== expect.totalLines) {
              failures.push(
                `${testCase.name}: totalLines was ${output.totalLines}, expected ${expect.totalLines}`,
              );
            }
            if (expect.truncated !== undefined && output.truncated !== expect.truncated) {
              failures.push(
                `${testCase.name}: truncated was ${output.truncated}, expected ${expect.truncated}`,
              );
            }
          }
        } else {
          const message = failure ?? output?.error;
          const expected = render(expect.error, home);
          if (message !== expected) {
            failures.push(
              `${testCase.name}: error was ${JSON.stringify(message)}, expected ${JSON.stringify(expected)}`,
            );
          }
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }

    expect(failures).toEqual([]);
  });
});
