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

  it('every gated command name in the rule registry resolves to a known CLI command (Codex P2 round 1)', async () => {
    // S5-3 acceptance: GATED_OPERATIONS cannot reference phantom commands.
    // Compare GATED_OPERATIONS commands against CLI_COMPLETION_COMMANDS
    // *directly* — not against the matrix (which is built from the same
    // input), since that would be tautological.
    const { GATED_OPERATIONS } = await import('../../src/infra/auth/operator-gate.js');
    const { CLI_COMPLETION_COMMANDS } = await import('../../src/infra/cli/registry.js');
    const knownCommands = new Set<string>(CLI_COMPLETION_COMMANDS);
    for (const rule of GATED_OPERATIONS) {
      expect(
        knownCommands.has(rule.command),
        `GATED_OPERATIONS rule references unknown command "${rule.command}" — rename or typo?`,
      ).toBe(true);
    }
  });
});
