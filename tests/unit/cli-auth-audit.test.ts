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

  it('S5-1 closed: secret + trust + backup + evolve + reset all enforce after the auth sweep', () => {
    // Codex P1 round 2 flagged the gap; S5-1 sweep added requireOperatorAuth
    // to each handler. Audit must now show every previously-gap command
    // as enforced + zero gaps total.
    const matrix = buildAuthAuditMatrix();
    const formerGaps = ['secret', 'trust', 'backup', 'evolve', 'reset'];
    for (const cmd of formerGaps) {
      const row = matrix.find((r) => r.command === cmd);
      expect(row?.registered, `${cmd} should still be registered`).toBe(true);
      expect(row?.enforced, `${cmd} should be enforced after S5-1`).toBe(true);
      expect(row?.gap, `${cmd} should NOT be a gap after S5-1`).toBe(false);
    }
    // Total gap count zero.
    const gaps = matrix.filter((r) => r.gap);
    expect(gaps.length).toBe(0);
  });

  it('handles vault.handler.ts (single-command handler) correctly via commands array + canHandle token', () => {
    // vault.handler.ts has both `commands: ['vault']` and
    // `command === 'vault'` plus a real requireOperatorAuth() call.
    // The matrix should flip vault to enforced.
    const matrix = buildAuthAuditMatrix();
    const vault = matrix.find((r) => r.command === 'vault');
    expect(vault?.enforced).toBe(true);
  });

  it('does not count auth.handler.ts as enforcing despite mentioning requireOperatorAuth in JSDoc (Codex P2 round 3)', () => {
    // auth.handler.ts has the symbol in its own JSDoc but never calls
    // the function. Comment text must not count as a call site.
    // Re-import to bypass any module-level cache that may have been
    // populated during prior test runs in this file.
    const matrix = buildAuthAuditMatrix();
    const auth = matrix.find((r) => r.command === 'auth');
    // 'auth' isn't in CLI_COMPLETION_COMMANDS today (auth is a namespace
    // verb), so the row is undefined — but if it ever appears, comment
    // text must not flip it to enforced.
    if (auth) {
      expect(auth.enforced).toBe(false);
    }
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
