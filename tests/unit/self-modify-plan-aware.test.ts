/**
 * S5 A.5.3 — plan-aware self_modify preflight checks.
 *
 * Verifies that when `plan_id` + `step_idx` are passed but the step is
 * in a non-runnable state (done/in_progress/skipped), self_modify
 * refuses early WITHOUT creating an evolve session, branching, or
 * running tests. This is the idempotency contract that lets a
 * multi-turn execution loop retry without double-applying changes.
 *
 * Mocks: same shape as self-modify-rawenv-threading.test.ts — we only
 * need to reach the preflight gate, which lives before any side effect.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMemphisSelfModify } from '../../src/mcp/tools/self-modify.js';
import {
  advanceStep,
  createPlan,
  getPlan,
} from '../../src/modules/self-coding/plan-store.js';

vi.mock('../../src/soul/manifest.js', () => {
  return {
    ensureSoulManifest: vi.fn(),
    loadSoulManifest: vi.fn(() => null),
  };
});

vi.mock('../../src/infra/git-utils.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

const fakeDeps = (rawEnv: NodeJS.ProcessEnv) =>
  ({
    sessionRepo: {
      create: vi.fn().mockReturnValue({ id: 'sess-1' }),
      updateStatus: vi.fn(),
      getById: vi.fn().mockReturnValue(null),
    },
    rollback: {
      createSnapshot: vi.fn().mockResolvedValue('snap-1'),
      rollback: vi.fn(),
    },
    caseAdapter: {
      appendCaseEntry: vi.fn(),
    },
    projectRoot: '/tmp/fake',
    rawEnv,
  }) as unknown as Parameters<typeof runMemphisSelfModify>[1];

describe('self_modify plan-aware preflight', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-self-modify-plan-'));
    env = { ...process.env, MEMPHIS_HOME: home, MEMPHIS_SELF_CODING_PLANS: '1' };
  });

  afterEach(() => {
    if (env.MEMPHIS_HOME) {
      rmSync(env.MEMPHIS_HOME, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('refuses when plan_id is unknown', async () => {
    const deps = fakeDeps(env);
    const result = await runMemphisSelfModify(
      {
        intent: 'noop',
        files: ['src/x.ts'],
        changes: { 'src/x.ts': '' },
        plan_id: 'plan-bogus',
        step_idx: 0,
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.step_skip_reason).toContain('plan not found');
    expect(result.plan_id).toBe('plan-bogus');
    expect(result.step_idx).toBe(0);
    // No side effects: sessionRepo.create never called.
    expect(
      (deps.sessionRepo as unknown as { create: ReturnType<typeof vi.fn> }).create,
    ).not.toHaveBeenCalled();
  });

  it('refuses when step idx is out of range', async () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    const deps = fakeDeps(env);
    const result = await runMemphisSelfModify(
      {
        intent: 'noop',
        files: ['src/x.ts'],
        changes: { 'src/x.ts': '' },
        plan_id: plan.id,
        step_idx: 99,
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.step_skip_reason).toContain('step idx out of range');
  });

  it('refuses when step is already done (idempotency)', async () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'done', artifact: 'a' }, env);
    const deps = fakeDeps(env);
    const result = await runMemphisSelfModify(
      {
        intent: 'retry',
        files: ['src/x.ts'],
        changes: { 'src/x.ts': '' },
        plan_id: plan.id,
        step_idx: 0,
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.step_skip_reason).toContain('step already done');
    expect(
      (deps.sessionRepo as unknown as { create: ReturnType<typeof vi.fn> }).create,
    ).not.toHaveBeenCalled();
  });

  it('refuses when step is already in_progress (concurrency)', async () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'in_progress' }, env);
    const deps = fakeDeps(env);
    const result = await runMemphisSelfModify(
      {
        intent: 'concurrent',
        files: ['src/x.ts'],
        changes: { 'src/x.ts': '' },
        plan_id: plan.id,
        step_idx: 0,
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.step_skip_reason).toContain('in_progress');
  });

  it('refuses when step is marked skipped', async () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'skipped' }, env);
    const deps = fakeDeps(env);
    const result = await runMemphisSelfModify(
      {
        intent: 'after-skip',
        files: ['src/x.ts'],
        changes: { 'src/x.ts': '' },
        plan_id: plan.id,
        step_idx: 0,
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.step_skip_reason).toContain('skipped');
  });

  it('marks step in_progress upfront then failed when downstream validation fails', async () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    const deps = fakeDeps(env);
    // Force the empty-files branch — gets past preflight, then trips
    // input validation.
    await runMemphisSelfModify(
      {
        intent: 'empty',
        files: [],
        changes: {},
        plan_id: plan.id,
        step_idx: 0,
      },
      deps,
    );
    const reloaded = getPlan(plan.id, env)!;
    expect(reloaded.steps[0].status).toBe('failed');
    expect(reloaded.steps[0].lastError).toContain('No files or changes');
    // Preflight bumped attempts on in_progress (+1); failed transition bumps again (+1).
    expect(reloaded.steps[0].attempts).toBeGreaterThanOrEqual(2);
  });

  it('passes through unchanged when plan_id is absent (backward compat)', async () => {
    const deps = fakeDeps(env);
    const result = await runMemphisSelfModify(
      {
        intent: 'classic',
        files: [],
        changes: {},
      },
      deps,
    );
    expect(result.plan_id).toBeUndefined();
    expect(result.step_idx).toBeUndefined();
    expect(result.step_skip_reason).toBeUndefined();
    expect(result.rollbackReason).toContain('No files or changes');
  });
});
