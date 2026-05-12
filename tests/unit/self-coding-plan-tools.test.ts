/**
 * S5 A.5.2 — handler-level tests for the 4 plan MCP tools.
 *
 * Covers: create→get→advance→cancel happy path, get unknown id, advance
 * unknown id, advance step idx out of range, cancel requires reason,
 * advance error propagation (invalid status).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runMemphisSelfPlanAdvance,
  runMemphisSelfPlanCancel,
  runMemphisSelfPlanCreate,
  runMemphisSelfPlanGet,
} from '../../src/mcp/tools/self-plan.js';

function makeEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'memphis-plan-tools-'));
  return { ...process.env, MEMPHIS_HOME: home, MEMPHIS_SELF_CODING_PLANS: '1' };
}

describe('memphis_self_plan_* MCP handlers', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    if (env.MEMPHIS_HOME) {
      rmSync(env.MEMPHIS_HOME, { recursive: true, force: true });
    }
  });

  it('create → get → advance → cancel end-to-end', () => {
    const created = runMemphisSelfPlanCreate(
      {
        goal: 'wire memphis_weather tool',
        steps: [
          { description: 'register' },
          { description: 'implement' },
          { description: 'wire executor' },
        ],
      },
      env,
    );
    expect(created.ok).toBe(true);
    expect(created.plan_id).toMatch(/^plan-/);

    const got = runMemphisSelfPlanGet({ plan_id: created.plan_id }, env);
    expect(got.ok).toBe(true);
    expect(got.plan?.goal).toBe('wire memphis_weather tool');
    expect(got.next_step?.idx).toBe(0);

    const adv1 = runMemphisSelfPlanAdvance(
      {
        plan_id: created.plan_id,
        step_idx: 0,
        status: 'in_progress',
      },
      env,
    );
    expect(adv1.ok).toBe(true);
    expect(adv1.plan?.status).toBe('executing');
    expect(adv1.plan?.steps[0].attempts).toBe(1);

    const adv2 = runMemphisSelfPlanAdvance(
      {
        plan_id: created.plan_id,
        step_idx: 0,
        status: 'done',
        artifact: 'src/gateway/tool-registry.ts',
      },
      env,
    );
    expect(adv2.ok).toBe(true);
    expect(adv2.next_step?.idx).toBe(1);

    const cancelled = runMemphisSelfPlanCancel(
      { plan_id: created.plan_id, reason: 'redirected' },
      env,
    );
    expect(cancelled.ok).toBe(true);
    expect(cancelled.plan?.status).toBe('cancelled');
  });

  it('get returns ok=false with error message on unknown plan', () => {
    const got = runMemphisSelfPlanGet({ plan_id: 'plan-bogus' }, env);
    expect(got.ok).toBe(false);
    expect(got.error).toContain('plan not found');
  });

  it('get returns ok=false on empty plan_id', () => {
    const got = runMemphisSelfPlanGet({ plan_id: '   ' }, env);
    expect(got.ok).toBe(false);
    expect(got.error).toContain('plan_id is required');
  });

  it('advance returns ok=false on unknown plan or step idx', () => {
    const r1 = runMemphisSelfPlanAdvance(
      { plan_id: 'bogus', step_idx: 0, status: 'done' },
      env,
    );
    expect(r1.ok).toBe(false);

    const created = runMemphisSelfPlanCreate(
      { goal: 'g', steps: [{ description: 's0' }] },
      env,
    );
    const r2 = runMemphisSelfPlanAdvance(
      { plan_id: created.plan_id, step_idx: 99, status: 'done' },
      env,
    );
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('out of range');
  });

  it('advance rejects invalid status without crashing the runtime', () => {
    const created = runMemphisSelfPlanCreate(
      { goal: 'g', steps: [{ description: 's0' }] },
      env,
    );
    const r = runMemphisSelfPlanAdvance(
      {
        plan_id: created.plan_id,
        step_idx: 0,
        status: 'bogus' as 'done',
      },
      env,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid step status');
  });

  it('advance rejects non-integer step_idx', () => {
    const r = runMemphisSelfPlanAdvance(
      { plan_id: 'x', step_idx: 1.5, status: 'done' },
      env,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('non-negative integer');
  });

  it('cancel requires reason', () => {
    const created = runMemphisSelfPlanCreate(
      { goal: 'g', steps: [{ description: 's0' }] },
      env,
    );
    const r = runMemphisSelfPlanCancel(
      { plan_id: created.plan_id, reason: '   ' },
      env,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('reason is required');
  });
});
