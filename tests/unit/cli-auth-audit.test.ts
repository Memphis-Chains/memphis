import { describe, expect, it } from 'vitest';

import { buildAuthAuditMatrix } from '../../src/infra/cli/handlers/auth.handler.js';

describe('memphis auth audit (S5-3)', () => {
  it('lists every CLI command with registered + enforced status', () => {
    const matrix = buildAuthAuditMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    // Each row has the canonical shape.
    for (const row of matrix) {
      expect(typeof row.command).toBe('string');
      expect(typeof row.registered).toBe('boolean');
      expect(typeof row.enforced).toBe('boolean');
      expect(typeof row.gap).toBe('boolean');
      expect(Array.isArray(row.rules)).toBe(true);
      // gap is computed: registered ∧ ¬enforced.
      expect(row.gap).toBe(row.registered && !row.enforced);
    }
  });

  it('marks vault as both registered and enforced (vault.handler.ts calls requireOperatorAuth)', () => {
    const matrix = buildAuthAuditMatrix();
    const vault = matrix.find((r) => r.command === 'vault');
    expect(vault?.registered).toBe(true);
    expect(vault?.enforced).toBe(true);
    expect(vault?.gap).toBe(false);
  });

  it('detects the registry-vs-handler gaps Codex flagged (P1 round 2): secret + trust are registered but their handlers do not call requireOperatorAuth', () => {
    const matrix = buildAuthAuditMatrix();
    const secret = matrix.find((r) => r.command === 'secret');
    const trust = matrix.find((r) => r.command === 'trust');
    // Both registered.
    expect(secret?.registered).toBe(true);
    expect(trust?.registered).toBe(true);
    // Both currently NOT enforced (the gap S5-1 closes).
    expect(secret?.enforced).toBe(false);
    expect(trust?.enforced).toBe(false);
    // Therefore both are gaps.
    expect(secret?.gap).toBe(true);
    expect(trust?.gap).toBe(true);
  });

  it('marks read-only/diagnostic commands as neither registered nor enforced (doctor, models, ascii)', () => {
    const matrix = buildAuthAuditMatrix();
    const readOnly = ['doctor', 'models', 'ascii', 'help', 'progress', 'celebrate', 'guide'];
    for (const cmd of readOnly) {
      const row = matrix.find((r) => r.command === cmd);
      expect(row?.registered, `${cmd} should not be registered`).toBe(false);
      expect(row?.enforced, `${cmd} should not be enforced`).toBe(false);
      expect(row?.gap, `${cmd} should not be a gap`).toBe(false);
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
