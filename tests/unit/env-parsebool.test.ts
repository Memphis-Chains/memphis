/**
 * Verifies `parseBool` accepts the conventional truthy/falsy strings.
 *
 * Why: error messages across the codebase instruct operators to use
 * `=1` for boolean env flags (e.g. the vault re-init guard's
 * "set MEMPHIS_VAULT_FORCE_REINIT=1"). Previously parseBool only
 * accepted the literal `"true"`, so the documented workaround failed
 * silently. The error message and the parser must agree.
 *
 * Operator's 2026-04-27 trace: ran `MEMPHIS_VAULT_FORCE_REINIT=1
 * memphis vault init` exactly as the error message instructed; the guard
 * still threw VaultAlreadyInitializedError because parseBool returned
 * false for "1".
 */

import { describe, expect, it } from 'vitest';

import { parseBool } from '../../src/core/env.js';

describe('parseBool', () => {
  it('accepts conventional truthy strings', () => {
    for (const value of ['true', '1', 'yes', 'on']) {
      expect(parseBool(value)).toBe(true);
      expect(parseBool(value.toUpperCase())).toBe(true);
    }
  });

  it('accepts conventional falsy strings', () => {
    for (const value of ['false', '0', 'no', 'off']) {
      expect(parseBool(value)).toBe(false);
      expect(parseBool(value.toUpperCase())).toBe(false);
    }
  });

  it('uses the fallback for undefined', () => {
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool(undefined, false)).toBe(false);
  });

  it('uses the fallback for unrecognized strings', () => {
    expect(parseBool('maybe', true)).toBe(true);
    expect(parseBool('maybe', false)).toBe(false);
    expect(parseBool('', true)).toBe(true);
    expect(parseBool('   ', false)).toBe(false);
  });

  it('handles whitespace around the value', () => {
    expect(parseBool('  true  ')).toBe(true);
    expect(parseBool('\t1\n')).toBe(true);
    expect(parseBool('  false  ')).toBe(false);
  });

  it('matches the documented MEMPHIS_VAULT_FORCE_REINIT=1 instruction', () => {
    // Regression for operator's 2026-04-27 self-contradicting error message.
    expect(parseBool('1', false)).toBe(true);
  });
});
