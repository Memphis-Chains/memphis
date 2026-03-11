import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { traceCommand } from '../../src/infra/cli/commands/debug.js';

describe('debug trace', () => {
  it('captures execution steps and timings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trace-'));
    const script = join(dir, 'echo.js');
    writeFileSync(script, 'console.log(42);\n', 'utf8');

    const result = traceCommand(`${process.execPath} ${script}`);

    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.steps.some((step) => step.step === 'function_call')).toBe(true);
    expect(result.steps.every((step) => step.durationMs >= 0)).toBe(true);
    expect(typeof result.output).toBe('string');
  });
});
