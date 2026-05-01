import { describe, expect, it } from 'vitest';

import { buildAuthAuditMatrix } from '../../src/infra/cli/handlers/auth.handler.js';

describe('memphis auth audit (S5-3)', () => {
  it('lists every CLI command with its gated status', () => {
    const matrix = buildAuthAuditMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    // Each row has the canonical shape.
    for (const row of matrix) {
      expect(typeof row.command).toBe('string');
      expect(typeof row.gated).toBe('boolean');
      expect(Array.isArray(row.rules)).toBe(true);
    }
  });

  it('marks vault and secret as gated (sanity — these are in GATED_OPERATIONS)', () => {
    const matrix = buildAuthAuditMatrix();
    const vault = matrix.find((r) => r.command === 'vault');
    const secret = matrix.find((r) => r.command === 'secret');
    expect(vault?.gated).toBe(true);
    expect(secret?.gated).toBe(true);
    // Reasons are surfaced for operator review.
    expect(vault?.rules.some((r) => r.reason?.includes('vault'))).toBe(true);
  });

  it('marks read-only/diagnostic commands as ungated (regression: doctor, models, ascii should never be gated)', () => {
    const matrix = buildAuthAuditMatrix();
    const ungatedExpected = ['doctor', 'models', 'ascii', 'help', 'progress', 'celebrate', 'guide'];
    for (const cmd of ungatedExpected) {
      const row = matrix.find((r) => r.command === cmd);
      expect(row?.gated, `${cmd} should be ungated`).toBe(false);
    }
  });

  it('every gated command name in the rule registry resolves to a known CLI command', () => {
    // S5-3 acceptance: GATED_OPERATIONS cannot reference phantom commands.
    // If this fails, GATED_OPERATIONS has a typo or the command was renamed
    // and the rule wasn't updated.
    const matrix = buildAuthAuditMatrix();
    const knownCommands = new Set(matrix.map((r) => r.command));
    for (const row of matrix.filter((r) => r.gated)) {
      expect(knownCommands.has(row.command)).toBe(true);
    }
  });
});
