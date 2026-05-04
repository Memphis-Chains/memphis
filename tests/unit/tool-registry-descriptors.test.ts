/**
 * Sprint E Phase 1 (PR #430) — ToolDescriptor foundation contract.
 *
 * Plan #2 in `~/.claude/plans/memphis-architectural-refactor.md` is the
 * declarative tool registry refactor. Phase 1 ships the descriptor
 * fields (`helpText`, `cliFlags`) on the existing `ToolMeta` shape +
 * populates 4 high-traffic tier-0 tools as proof. This test pins:
 *
 *  1. Every "rich descriptor" tool in the proof set has both fields.
 *  2. Each cliFlag is well-formed (long-form name, description).
 *  3. Tools without descriptors gracefully fall back to `description`.
 *
 * As Phase 2/3 land more migrations, this file's PROOF_SET grows. When
 * every TOOL_REGISTRY entry has a descriptor, the test asserts global
 * coverage and the static `description`-only fallback can be removed.
 */
import { describe, expect, it } from 'vitest';

import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';

const PROOF_SET = [
  // Phase 1 (#429) — original 4 tier-0 tools
  'memphis_journal',
  'memphis_recall',
  'memphis_search',
  'memphis_health',
  // Phase 3 batch 1 (this PR) — 5 more tier-0 tools
  'memphis_decide',
  'memphis_self_describe',
  'memphis_repair',
  'memphis_soul_read',
  'memphis_soul_write',
] as const;

describe('ToolDescriptor — Phase 1 foundation', () => {
  it.each(PROOF_SET)('%s exposes helpText (richer than description)', (name) => {
    const meta = TOOL_REGISTRY[name];
    expect(meta, `tool ${name} not in registry`).toBeDefined();
    expect(meta.helpText, `${name} should expose helpText`).toBeDefined();
    expect(meta.helpText!.length).toBeGreaterThan(meta.description.length);
  });

  it.each(PROOF_SET)('%s exposes cliFlags array (possibly empty)', (name) => {
    const meta = TOOL_REGISTRY[name];
    expect(Array.isArray(meta.cliFlags), `${name} cliFlags should be an array`).toBe(true);
  });

  it('every cliFlag entry has long-form name + description', () => {
    for (const name of PROOF_SET) {
      const meta = TOOL_REGISTRY[name];
      for (const flag of meta.cliFlags ?? []) {
        expect(flag.name.startsWith('--'), `${name} flag ${flag.name} must start with --`).toBe(
          true,
        );
        expect(flag.description.length, `${name} flag ${flag.name} needs description`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('non-proof tools work without a descriptor (fallback to description)', () => {
    // Every other entry in TOOL_REGISTRY can lack helpText / cliFlags
    // and surfaces still render `description`. This pins the soft-rollout
    // contract — Phase 2/3 expand the proof set without touching consumers.
    const nonProof = Object.values(TOOL_REGISTRY).filter(
      (meta) => !PROOF_SET.includes(meta.name as (typeof PROOF_SET)[number]),
    );
    expect(nonProof.length).toBeGreaterThan(0);
    for (const meta of nonProof) {
      expect(meta.description.length, `${meta.name} must keep its description`).toBeGreaterThan(0);
    }
  });

  it('proof set covers a representative tier-0 sample', () => {
    // Drift detection: if someone narrows the proof set without expanding
    // it, we'd lose coverage of the foundation pattern.
    expect(PROOF_SET.length).toBeGreaterThanOrEqual(4);
    for (const name of PROOF_SET) {
      expect(TOOL_REGISTRY[name].tier, `${name} should be tier 0 in proof set`).toBe(0);
    }
  });
});
