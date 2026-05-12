/**
 * S5 A.5.4 — plan-review pure logic.
 *
 * Uses an in-memory DiffProbe so we don't have to spin up a real git
 * repo for unit-level coverage. The integration with live git lives in
 * src/mcp/tools/self-review.ts (GitDiffProbe) and is covered manually
 * in operator-side B-step testing.
 */
import { describe, expect, it } from 'vitest';

import {
  runPlanReview,
  type DiffProbe,
} from '../../src/modules/self-coding/plan-review.js';
import type { SelfCodingPlan } from '../../src/modules/self-coding/plan-types.js';

function planFixture(overrides: Partial<SelfCodingPlan> = {}): SelfCodingPlan {
  return {
    id: 'plan-test',
    goal: 'add memphis_weather tool',
    steps: [
      {
        idx: 0,
        description: 'register memphis_weather in TOOL_REGISTRY',
        status: 'done',
        artifact: 'abc123',
        attempts: 1,
      },
      {
        idx: 1,
        description: 'implement runMemphisWeather handler',
        status: 'done',
        artifact: 'def456',
        attempts: 1,
      },
      {
        idx: 2,
        description: 'wire memphis_weather into MCP server route',
        status: 'done',
        artifact: '7890ab',
        attempts: 1,
      },
    ],
    status: 'reviewing',
    createdBy: 'memphis',
    createdAt: '2026-05-12T20:00:00Z',
    updatedAt: '2026-05-12T20:30:00Z',
    ...overrides,
  };
}

function probe(
  changed: string[],
  todoLines: Array<{ file: string; line: string }> = [],
): DiffProbe {
  return {
    changedFiles: async () => changed,
    addedLinesMatching: async () => todoLines,
  };
}

describe('runPlanReview', () => {
  it('happy path — all steps done with artifact, files match steps, no TODOs', async () => {
    const plan = planFixture();
    const result = await runPlanReview(
      plan,
      probe([
        'src/gateway/tool-registry.ts',
        'src/mcp/tools/weather.ts',
        'src/mcp/server.ts',
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('flags step done with no artifact (data corruption)', async () => {
    const plan = planFixture();
    plan.steps[1].artifact = undefined;
    const result = await runPlanReview(plan, probe([]));
    expect(result.ok).toBe(false);
    expect(result.checklist.gap_steps_no_artifact).toEqual([1]);
    expect(result.blockers.some((b) => b.includes('no artifact'))).toBe(true);
  });

  it('flags non-terminal steps as unfinished', async () => {
    const plan = planFixture();
    plan.steps[2].status = 'pending';
    const result = await runPlanReview(plan, probe([]));
    expect(result.ok).toBe(false);
    expect(result.checklist.gap_steps_unfinished).toEqual([2]);
  });

  it('treats skipped steps as legitimately terminal (no unfinished flag)', async () => {
    const plan = planFixture();
    plan.steps[2].status = 'skipped';
    plan.steps[2].artifact = undefined;
    const result = await runPlanReview(plan, probe([]));
    // No "skipped" appears in either gap list — skip is intentional.
    expect(result.checklist.gap_steps_unfinished).toEqual([]);
    expect(result.checklist.gap_steps_no_artifact).toEqual([]);
  });

  it('flags scope creep (file not named by any step)', async () => {
    const plan = planFixture();
    const result = await runPlanReview(
      plan,
      probe([
        'src/gateway/tool-registry.ts', // matches step 0 (tool-registry)
        'src/mcp/tools/weather.ts', // matches step 1 (weather)
        'src/billing/stripe-secrets.ts', // matches NO step → creep
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.checklist.scope_creep_files).toContain('src/billing/stripe-secrets.ts');
    expect(result.checklist.scope_creep_files).not.toContain('src/mcp/tools/weather.ts');
  });

  it('flags TODO/FIXME lines added in the diff', async () => {
    const plan = planFixture();
    const result = await runPlanReview(
      plan,
      probe(
        ['src/mcp/tools/weather.ts'],
        [
          { file: 'src/mcp/tools/weather.ts', line: '// TODO: handle rate-limit' },
          { file: 'src/mcp/tools/weather.ts', line: '// FIXME: drop this cast' },
        ],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.checklist.todo_fixme_lines).toHaveLength(2);
    expect(result.blockers.some((b) => b.includes('TODO/FIXME'))).toBe(true);
  });

  it('returns multiple blockers when multiple classes fail', async () => {
    const plan = planFixture();
    plan.steps[0].artifact = undefined;
    plan.steps[1].status = 'failed';
    const result = await runPlanReview(
      plan,
      probe(
        ['src/randomfile.ts'],
        [{ file: 'src/randomfile.ts', line: '// XXX broken' }],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.blockers.length).toBeGreaterThanOrEqual(3); // gap-artifact + unfinished + creep + TODO
  });
});
