import { describe, expect, it } from 'vitest';
import { traceCommand } from '../../src/infra/cli/commands/debug.js';

describe('debug trace', () => {
  it('captures execution steps and timings', () => {
    const result = traceCommand('node -e "console.log(42)"');
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.steps.some((s) => s.step === 'function_call')).toBe(true);
    expect(result.steps.every((s) => s.durationMs >= 0)).toBe(true);
    expect(result.output).toContain('42');
  });
});
