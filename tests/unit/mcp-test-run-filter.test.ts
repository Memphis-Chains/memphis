import { describe, expect, it } from 'vitest';

import { runMemphisTest } from '../../src/mcp/tools/test-run.js';

/**
 * Regression net for #137: memphis_test.filter was pushed raw into the
 * vitest argv. Any flag starting with '-' became a vitest CLI option, and
 * --config=<path> loads and executes the file as JS — chained with
 * fs-write that's arbitrary code execution via a tier-2 tool. Fix: restrict
 * filter to a plain test-name pattern.
 */

describe('memphis_test filter validation (#137)', () => {
  it('rejects filter starting with --', () => {
    const result = runMemphisTest({ suite: 'ts', filter: '--config=/tmp/x.ts' });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/flags are not allowed/);
  });

  it('rejects short-flag filter (-c path)', () => {
    const result = runMemphisTest({ suite: 'ts', filter: '-c /tmp/x.ts' });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/flags are not allowed/);
  });

  it('rejects filter containing shell metacharacters', () => {
    const result = runMemphisTest({ suite: 'ts', filter: 'name; touch /tmp/x' });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/must be a plain test-name pattern/);
  });

  it('rejects filter with equals (--config= form)', () => {
    const result = runMemphisTest({ suite: 'ts', filter: '--config=x.ts' });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/flags are not allowed/);
  });

  // Sanity: allowed characters in a real test-name pattern should still
  // pass validation — we stop before actually running vitest because the
  // test runner itself is out of scope for this unit.
  it('accepts alphanumeric test-name pattern (does not reject at validation)', () => {
    // We can't easily run vitest inside vitest; we verify the validator
    // didn't reject by ensuring the error message is absent from the
    // first 200ms of execution. Keeping the assertion narrow.
    const result = runMemphisTest({ suite: 'ts', filter: 'my-test_name' });
    // Either it ran (passed or failed based on tests) OR it's an actual
    // test-gate failure — but NOT a validation rejection.
    if (result.error !== undefined) {
      expect(result.error).not.toMatch(/must be a plain test-name pattern/);
      expect(result.error).not.toMatch(/flags are not allowed/);
    }
  }, 60000);
});
